#!/usr/bin/env python3
"""
Lyric analysis worker — rides inside the CLAP sidecar container.

Consumes {trackId} jobs from the `lyrics:analysis:queue` Redis list, re-reads
lyric text from the TrackLyrics table, and writes back in one transaction:
  - three scalars onto TrackLyrics (sentiment / lexicalDiversity / readingLevel)
  - a 768-D semantic embedding into track_lyric_embeddings
    (nomic-embed-text-v1.5 via HF transformers, baked into the image)

Contract notes (mirrors the CLAP audio worker):
  - This worker is the ONLY writer of lyric analysis *results*; the backend
    only flips analysisStatus (queueing, stale sweeps).
  - Heartbeat key `lyrics:worker:heartbeat` is the backend's sole evidence a
    lyric worker exists — featureDetection has no bundled-script fallback for
    this worker, so queueing stops entirely if the heartbeat goes stale.
  - Failure/success callbacks POST to the backend with X-Internal-Secret
    (fails closed backend-side when unset — same as the vibe callbacks).

Heavy imports (torch/transformers, redis, psycopg2) are deliberately lazy so
the pure text functions are unit-testable without the ML stack installed.
"""

import json
import os
import re
import threading
import time
import traceback
from datetime import datetime
from typing import List, Optional

import sys

_CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
_POTENTIAL_PROJECT_ROOTS = (
    _CURRENT_DIR,
    os.path.dirname(_CURRENT_DIR),
    os.path.dirname(os.path.dirname(_CURRENT_DIR)),
)
for _root in _POTENTIAL_PROJECT_ROOTS:
    if os.path.isdir(os.path.join(_root, "services", "common")):
        if _root not in sys.path:
            sys.path.insert(0, _root)
        break

from services.common.logging_utils import configure_service_logger
from services.common.analyzer_env import get_int_env

logger = configure_service_logger('lyric-analysis')

# Configuration from environment (shares the sidecar's REDIS_URL/DATABASE_URL/
# BACKEND_URL/INTERNAL_API_SECRET/MODEL_IDLE_TIMEOUT)
REDIS_URL = os.getenv('REDIS_URL', 'redis://localhost:6379')
DATABASE_URL = os.getenv('DATABASE_URL', '')
BACKEND_URL = os.getenv('BACKEND_URL', 'http://backend:3006')
LYRIC_WORKERS = get_int_env('LYRIC_WORKERS', 1)
MODEL_IDLE_TIMEOUT = get_int_env('MODEL_IDLE_TIMEOUT', 300)
SLEEP_INTERVAL = get_int_env('SLEEP_INTERVAL', 5)

# Names duplicated in backend/src (workers/unifiedEnrichment.ts,
# services/featureDetection.ts) — grep both sides before renaming.
LYRIC_QUEUE = 'lyrics:analysis:queue'
HEARTBEAT_KEY = 'lyrics:worker:heartbeat'

# analysisVersion stamped on TrackLyrics rows; bump when the scalar
# definitions change. model_version identifies the embedding model.
ANALYSIS_VERSION = 'lyr-v1'
EMBED_MODEL_VERSION = 'nomic-embed-text-v1.5'

# The model loads from the HF cache (HF_HOME baked in the image) at pinned
# immutable revisions. NOTE: nomic-embed-text-v1.5's config auto_map points
# its trust_remote_code modules at a SECOND repo (nomic-ai/nomic-bert-2048),
# so that repo must be in the cache too and its revision pinned separately
# via code_revision — otherwise from_pretrained dials huggingface.co at load.
NOMIC_MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5'
NOMIC_MODEL_REVISION = 'e9b6763023c676ca8431644204f50c2b100d9aab'
NOMIC_CODE_REVISION = '7710840340a098cfb869c4f65e87cf2b1b70caca'  # nomic-bert-2048

# Lyrics rarely exceed ~1k tokens; 2048 bounds CPU cost on pathological texts
# while never truncating a real song. Changing this changes embeddings —
# treat like a model-version bump.
MAX_TOKENS = 2048

MTLD_TTR_THRESHOLD = 0.72  # McCarthy & Jarvis (2010) canonical value


# --------------------------------------------------------------------------
# Pure text functions (no I/O, unit-tested without the ML stack)
# --------------------------------------------------------------------------

_LRC_TIMESTAMP = re.compile(r"\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]")
_LRC_METADATA_LINE = re.compile(r"^\s*\[[a-zA-Z#][^\]]*\]\s*$", re.MULTILINE)
_WORD = re.compile(r"[^\W\d_]+(?:'[^\W\d_]+)*", re.UNICODE)


def strip_lrc_timestamps(text: Optional[str]) -> str:
    """Drop [mm:ss.xx] tags and [ar:...]-style metadata lines from LRC text."""
    text = _LRC_TIMESTAMP.sub("", text or "")
    text = _LRC_METADATA_LINE.sub("", text)
    # Collapse runs of spaces/tabs but keep line structure for readability
    text = re.sub(r"[ \t]+", " ", text)
    return "\n".join(line.strip() for line in text.splitlines() if line.strip()).strip()


def tokenize(text: Optional[str]) -> List[str]:
    """Lowercased word tokens (unicode letters + internal apostrophes)."""
    return _WORD.findall((text or "").lower())


def mtld(tokens: List[str], ttr_threshold: float = MTLD_TTR_THRESHOLD) -> float:
    """
    Measure of Textual Lexical Diversity (McCarthy & Jarvis 2010),
    bidirectional mean. Length-robust, unlike raw type-token ratio — the whole
    reason it was chosen for "lyricist vs. repetitive" scoring.
    """
    if not tokens:
        return 0.0

    def _factors(seq: List[str]) -> float:
        factors = 0.0
        types: set = set()
        count = 0
        ttr = 1.0
        for tok in seq:
            count += 1
            types.add(tok)
            ttr = len(types) / count
            if ttr <= ttr_threshold:
                factors += 1.0
                types = set()
                count = 0
                ttr = 1.0
        if count > 0 and ttr < 1.0:
            # Partial factor for the trailing segment
            factors += (1.0 - ttr) / (1.0 - ttr_threshold)
        return factors

    mean_factors = (_factors(tokens) + _factors(list(reversed(tokens)))) / 2.0
    if mean_factors <= 0:
        # Never dipped below the threshold: fully diverse text — by convention
        # report the token count (diversity is at least as high as the length)
        return float(len(tokens))
    return round(len(tokens) / mean_factors, 2)


_SENTENCE_END = re.compile(r"[.!?]['\")\]]*\s*$")


def prepare_lyric_sentences(text: str) -> str:
    """
    Treat each lyric line as a sentence. Lyrics rarely carry terminal
    punctuation, and without it textstat sees the whole sheet as ONE sentence
    — observed FK grade ~130 on a real track. Appending a period to
    unpunctuated lines restores sane 0-15ish grades.
    """
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    return " ".join(
        line if _SENTENCE_END.search(line) else line + "." for line in lines
    )


def fk_grade(text: str) -> float:
    """Flesch-Kincaid grade level (textstat), line-as-sentence for lyrics."""
    import textstat
    return round(float(textstat.flesch_kincaid_grade(prepare_lyric_sentences(text))), 2)


_vader_analyzer = None


def vader_compound(text: str) -> float:
    """VADER compound sentiment in [-1, 1]."""
    global _vader_analyzer
    if _vader_analyzer is None:
        from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
        _vader_analyzer = SentimentIntensityAnalyzer()
    return round(float(_vader_analyzer.polarity_scores(text)["compound"]), 4)


def extract_lyric_text(plain_lyrics: Optional[str], synced_lyrics: Optional[str]) -> str:
    """Prefer plain lyrics; fall back to timestamp-stripped synced lyrics."""
    plain = (plain_lyrics or "").strip()
    if plain:
        return strip_lrc_timestamps(plain)
    return strip_lrc_timestamps(synced_lyrics)


# --------------------------------------------------------------------------
# Embedding model (lazy load + idle unload, mirroring CLAPAnalyzer)
# --------------------------------------------------------------------------

class NomicEmbedder:
    """nomic-embed-text-v1.5 wrapper: lazy load, idle unload, L2-normalized output."""

    def __init__(self, model_id: str = NOMIC_MODEL_ID):
        self.model_id = model_id
        self.model = None
        self.tokenizer = None
        self._lock = threading.Lock()
        self.last_work_time: float = time.time()

    def load(self):
        with self._lock:
            if self.model is not None:
                return
            logger.info("Loading nomic-embed-text model...")
            from transformers import AutoModel, AutoTokenizer
            # local_files_only: both repos are baked into the image's HF cache
            # at pinned revisions (Dockerfile); never dial out at runtime.
            self.tokenizer = AutoTokenizer.from_pretrained(
                self.model_id,
                revision=NOMIC_MODEL_REVISION,
                trust_remote_code=True,
                local_files_only=True,
            )
            self.model = (
                AutoModel.from_pretrained(
                    self.model_id,
                    revision=NOMIC_MODEL_REVISION,
                    code_revision=NOMIC_CODE_REVISION,
                    trust_remote_code=True,
                    local_files_only=True,
                )
                .eval()
            )
            self.last_work_time = time.time()
            logger.info("nomic-embed-text model loaded")

    def unload(self):
        with self._lock:
            if self.model is None:
                return
            logger.info("Unloading nomic-embed-text model to free memory...")
            self.model = None
            self.tokenizer = None
            import gc
            gc.collect()
            try:
                import ctypes
                ctypes.CDLL("libc.so.6").malloc_trim(0)
            except Exception:
                pass
            logger.info("nomic-embed-text model unloaded")

    def maybe_unload_idle(self):
        if self.model is not None and MODEL_IDLE_TIMEOUT > 0:
            if time.time() - self.last_work_time >= MODEL_IDLE_TIMEOUT:
                self.unload()

    def embed(self, text: str):
        """Return a float list of length 768 (mean-pool → layer_norm → L2)."""
        if self.model is None:
            self.load()
        self.last_work_time = time.time()

        import torch
        import torch.nn.functional as F

        with torch.no_grad():
            # Task prefix per nomic usage docs; "clustering" fits
            # similarity-among-documents (lyrics vs lyrics, no queries)
            inputs = self.tokenizer(
                "clustering: " + text,
                padding=True,
                truncation=True,
                max_length=MAX_TOKENS,
                return_tensors="pt",
            )
            out = self.model(**inputs)
            hidden = out.last_hidden_state
            mask = inputs["attention_mask"].unsqueeze(-1).expand(hidden.size()).float()
            pooled = (hidden * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
            pooled = F.layer_norm(pooled, normalized_shape=(pooled.shape[1],))
            pooled = F.normalize(pooled, p=2, dim=1)
            return pooled[0].cpu().tolist()


# --------------------------------------------------------------------------
# Queue worker
# --------------------------------------------------------------------------

class LyricWorker:
    """
    BLPOPs `lyrics:analysis:queue`, analyzes, writes results in one transaction.

    db / redis_client are injectable for tests; built lazily at start() in the
    container (DatabaseConnection is reused from analyzer.py, which lives in
    the same directory in the image).
    """

    def __init__(self, worker_id: int, embedder: NomicEmbedder,
                 stop_event: threading.Event, db=None, redis_client=None):
        self.worker_id = worker_id
        self.embedder = embedder
        self.stop_event = stop_event
        self.db = db
        self.redis_client = redis_client

    def start(self):
        logger.info(f"Lyric worker {self.worker_id} starting...")
        try:
            if self.redis_client is None:
                import redis
                self.redis_client = redis.from_url(REDIS_URL)
            if self.db is None:
                from analyzer import DatabaseConnection
                self.db = DatabaseConnection(DATABASE_URL)
                self.db.connect()

            while not self.stop_event.is_set():
                try:
                    self.redis_client.set(
                        HEARTBEAT_KEY, str(int(time.time() * 1000))
                    )
                except Exception:
                    pass  # heartbeat is informational

                try:
                    had_job = self._process_job()
                    if not had_job:
                        self.embedder.maybe_unload_idle()
                except Exception as e:
                    logger.error(f"Lyric worker {self.worker_id} error: {e}")
                    traceback.print_exc()
                    try:
                        self.db.reconnect()
                    except Exception:
                        pass
                    time.sleep(SLEEP_INTERVAL)
        finally:
            if self.db:
                self.db.close()
            logger.info(f"Lyric worker {self.worker_id} stopped")

    def _process_job(self) -> bool:
        """Process one job; returns False when the queue poll timed out."""
        job_data = self.redis_client.blpop(LYRIC_QUEUE, timeout=SLEEP_INTERVAL)
        if not job_data:
            return False

        _, raw_job = job_data
        job = json.loads(raw_job)
        track_id = job.get('trackId')
        if not track_id:
            logger.warning(f"Invalid lyric job (no trackId): {job}")
            return True

        logger.info(f"Lyric worker {self.worker_id} processing track: {track_id}")

        row = self._fetch_lyrics_row(track_id)
        if row is None:
            # Row deleted between queueing and processing — ack and move on
            logger.warning(f"No TrackLyrics row for {track_id}; skipping")
            return True

        text = extract_lyric_text(row.get('plainLyrics'), row.get('syncedLyrics'))
        tokens = tokenize(text)

        # Defense in depth: the backend classifies instrumentals before
        # queueing, but a row edited since then may have gone empty.
        if len(tokens) == 0:
            self._mark_instrumental(track_id)
            return True

        try:
            sentiment = vader_compound(text)
            lexical_diversity = mtld(tokens)
            reading_level = fk_grade(text)
            embedding = self.embedder.embed(text)
        except Exception as e:
            self._mark_failed(track_id, f"Lyric analysis error: {e}")
            return True

        if self._store_results(track_id, sentiment, lexical_diversity,
                               reading_level, embedding):
            self._notify_backend('success', track_id)
            logger.info(f"Lyric worker {self.worker_id} completed track: {track_id}")
        else:
            self._mark_failed(track_id, "Failed to store lyric analysis results")
        return True

    def _fetch_lyrics_row(self, track_id: str):
        cursor = self.db.get_cursor()
        try:
            cursor.execute(
                'SELECT "plainLyrics", "syncedLyrics" FROM "TrackLyrics" '
                'WHERE "trackId" = %s',
                (track_id,),
            )
            return cursor.fetchone()
        finally:
            cursor.close()

    def _mark_instrumental(self, track_id: str):
        cursor = self.db.get_cursor()
        try:
            cursor.execute(
                'UPDATE "TrackLyrics" SET "analysisStatus" = %s, '
                '"isInstrumental" = true, "analysisStartedAt" = NULL '
                'WHERE "trackId" = %s',
                ('instrumental', track_id),
            )
            self.db.commit()
            logger.info(f"Track {track_id} classified instrumental (empty lyric text)")
        except Exception as e:
            logger.error(f"Failed to mark instrumental: {e}")
            self.db.rollback()
        finally:
            cursor.close()

    def _store_results(self, track_id: str, sentiment: float,
                       lexical_diversity: float, reading_level: float,
                       embedding: List[float]) -> bool:
        """Scalars + embedding land in ONE transaction — never half-written."""
        cursor = self.db.get_cursor()
        try:
            now = datetime.utcnow()
            cursor.execute(
                'UPDATE "TrackLyrics" SET '
                '"sentiment" = %s, "lexicalDiversity" = %s, "readingLevel" = %s, '
                '"analysisStatus" = %s, "analysisError" = NULL, '
                '"analysisStartedAt" = NULL, "analysisVersion" = %s, '
                '"analyzedAt" = %s '
                'WHERE "trackId" = %s',
                (sentiment, lexical_diversity, reading_level,
                 'completed', ANALYSIS_VERSION, now, track_id),
            )
            cursor.execute(
                'INSERT INTO track_lyric_embeddings '
                '(track_id, embedding, model_version, analyzed_at) '
                'VALUES (%s, %s::vector, %s, %s) '
                'ON CONFLICT (track_id) DO UPDATE SET '
                'embedding = EXCLUDED.embedding, '
                'model_version = EXCLUDED.model_version, '
                'analyzed_at = EXCLUDED.analyzed_at',
                (track_id, embedding, EMBED_MODEL_VERSION, now),
            )
            self.db.commit()
            return True
        except Exception as e:
            logger.error(f"Failed to store lyric analysis for {track_id}: {e}")
            self.db.rollback()
            return False
        finally:
            cursor.close()

    def _mark_failed(self, track_id: str, error: str):
        cursor = self.db.get_cursor()
        try:
            cursor.execute(
                'UPDATE "TrackLyrics" SET "analysisStatus" = %s, '
                '"analysisError" = %s, "analysisStartedAt" = NULL, '
                '"analysisRetryCount" = COALESCE("analysisRetryCount", 0) + 1 '
                'WHERE "trackId" = %s',
                ('failed', error[:500], track_id),
            )
            self.db.commit()
            logger.error(f"Lyric analysis failed for {track_id}: {error}")
        except Exception as e:
            logger.error(f"Failed to mark lyric analysis failed: {e}")
            self.db.rollback()
        finally:
            cursor.close()

        self._notify_backend('failure', track_id, error)

    def _notify_backend(self, kind: str, track_id: str, error: str = ""):
        """Best-effort callback; the backend fails closed without the secret."""
        try:
            import requests
            payload = {"trackId": track_id}
            if kind == 'failure':
                payload.update({
                    "errorMessage": error[:500],
                    "errorCode": "LYRIC_ANALYSIS_FAILED",
                })
            requests.post(
                f"{BACKEND_URL}/api/analysis/lyrics/{kind}",
                json=payload,
                headers={
                    "Content-Type": "application/json",
                    "X-Internal-Secret": os.getenv("INTERNAL_API_SECRET", ""),
                },
                timeout=5,
            )
        except Exception as report_err:
            logger.warning(f"Failed to notify backend ({kind}): {report_err}")


def start_lyric_workers(stop_event: threading.Event) -> List[threading.Thread]:
    """Spawn lyric worker threads; called from analyzer.py main()."""
    embedder = NomicEmbedder()  # lazy — loads on first job
    threads = []
    for i in range(LYRIC_WORKERS):
        worker = LyricWorker(i, embedder, stop_event)
        thread = threading.Thread(target=worker.start, name=f"LyricWorker-{i}")
        thread.daemon = True
        thread.start()
        threads.append(thread)
        logger.info(f"Started lyric worker thread {i}")
    return threads
