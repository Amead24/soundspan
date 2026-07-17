"""Behavior tests for the lyric analysis worker's pure functions and job flow.

The embedding model and all I/O are mocked — these tests run without
torch/transformers/redis/psycopg2 installed (vaderSentiment + textstat are
required, both tiny pure-python packages).
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path
from unittest.mock import MagicMock

SERVICE_DIR = Path(__file__).resolve().parents[1]
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

import json

import lyric_analysis as la


# ---------------------------------------------------------------------------
# Pure text functions
# ---------------------------------------------------------------------------

class TestStripLrcTimestamps:
    def test_removes_inline_timestamps(self):
        text = "[00:12.34]Hello darkness\n[01:02.50]my old friend"
        assert la.strip_lrc_timestamps(text) == "Hello darkness\nmy old friend"

    def test_removes_metadata_lines(self):
        text = "[ar:The Artist]\n[ti:The Title]\n[00:01.00]Real lyric line"
        assert la.strip_lrc_timestamps(text) == "Real lyric line"

    def test_plain_text_passes_through(self):
        assert la.strip_lrc_timestamps("Just plain lyrics") == "Just plain lyrics"

    def test_none_and_empty_are_empty(self):
        assert la.strip_lrc_timestamps(None) == ""
        assert la.strip_lrc_timestamps("   \n  ") == ""


class TestTokenize:
    def test_lowercases_and_splits_words(self):
        assert la.tokenize("Hello WORLD") == ["hello", "world"]

    def test_keeps_internal_apostrophes(self):
        assert la.tokenize("don't stop believin'") == ["don't", "stop", "believin"]

    def test_drops_digits_and_punctuation(self):
        assert la.tokenize("867-5309 / Jenny!") == ["jenny"]

    def test_empty_input(self):
        assert la.tokenize(None) == []
        assert la.tokenize("") == []


class TestMtld:
    def test_empty_tokens_scores_zero(self):
        assert la.mtld([]) == 0.0

    def test_repetitive_text_scores_low(self):
        tokens = ["la"] * 200
        assert la.mtld(tokens) < 5

    def test_diverse_text_scores_higher_than_repetitive(self):
        # 200 unique tokens vs 200 repeats of 4 tokens
        diverse = [f"word{i}" for i in range(200)]
        repetitive = ["la", "da", "di", "doo"] * 50
        assert la.mtld(diverse) > la.mtld(repetitive)

    def test_fully_unique_returns_token_count(self):
        tokens = [f"w{i}" for i in range(50)]
        assert la.mtld(tokens) == 50.0

    def test_length_robust_unlike_raw_ttr(self):
        # Same generating process, different lengths → MTLD should be close
        # (raw TTR would fall with length). Cycle of 20 words, ttr dips fast.
        base = [f"w{i % 20}" for i in range(100)]
        longer = [f"w{i % 20}" for i in range(400)]
        short_score = la.mtld(base)
        long_score = la.mtld(longer)
        assert abs(short_score - long_score) / short_score < 0.25


class TestScalars:
    def test_vader_sign_sanity(self):
        assert la.vader_compound("I love this beautiful wonderful day") > 0.3
        assert la.vader_compound("I hate this horrible terrible pain") < -0.3

    def test_fk_grade_orders_by_complexity(self):
        simple = "The cat sat. The dog ran. It was fun."
        complex_text = (
            "Notwithstanding the phenomenological considerations, "
            "the epistemological ramifications remain fundamentally "
            "incomprehensible to unsophisticated interlocutors."
        )
        assert la.fk_grade(complex_text) > la.fk_grade(simple)

    def test_fk_grade_treats_lyric_lines_as_sentences(self):
        # Real lyrics rarely have terminal punctuation; without the
        # line-as-sentence fix textstat scored a real track at grade ~130.
        lyrics = "\n".join(["we walk along the shore tonight"] * 40)
        grade = la.fk_grade(lyrics)
        assert 0 <= grade < 15

    def test_prepare_lyric_sentences_respects_existing_punctuation(self):
        prepared = la.prepare_lyric_sentences("First line\nAlready ended!\n\nThird")
        assert prepared == "First line. Already ended! Third."


class TestExtractLyricText:
    def test_prefers_plain_lyrics(self):
        assert la.extract_lyric_text("plain here", "[00:01.00]synced") == "plain here"

    def test_falls_back_to_stripped_synced(self):
        assert la.extract_lyric_text("", "[00:01.00]synced line") == "synced line"
        assert la.extract_lyric_text(None, "[00:01.00]synced line") == "synced line"


# ---------------------------------------------------------------------------
# Worker job flow (all I/O mocked)
# ---------------------------------------------------------------------------

def make_worker(row, embed_result=None, embed_error=None):
    db = MagicMock()
    cursor = MagicMock()
    db.get_cursor.return_value = cursor
    cursor.fetchone.return_value = row

    redis_client = MagicMock()
    redis_client.blpop.return_value = (
        b"lyrics:analysis:queue",
        json.dumps({"trackId": "t1"}).encode(),
    )

    embedder = MagicMock()
    if embed_error is not None:
        embedder.embed.side_effect = embed_error
    else:
        embedder.embed.return_value = embed_result or [0.1] * 768

    worker = la.LyricWorker(
        0, embedder, threading.Event(), db=db, redis_client=redis_client
    )
    # Silence backend callbacks in unit tests
    notifications = []
    worker._notify_backend = lambda kind, track_id, error="": notifications.append(
        (kind, track_id)
    )
    return worker, db, cursor, embedder, notifications


class TestProcessJob:
    def test_success_writes_scalars_and_embedding_in_one_commit(self):
        worker, db, cursor, embedder, notifications = make_worker(
            {"plainLyrics": "I love this wonderful day, " * 30, "syncedLyrics": None}
        )

        assert worker._process_job() is True

        sql_calls = [c.args[0] for c in cursor.execute.call_args_list]
        update_sqls = [s for s in sql_calls if s.startswith('UPDATE "TrackLyrics"')]
        insert_sqls = [s for s in sql_calls if "track_lyric_embeddings" in s]
        assert len(update_sqls) == 1
        assert len(insert_sqls) == 1
        assert "'completed'" not in update_sqls[0]  # parametrized, not inlined
        # Exactly one commit for the whole result write (fetch has none)
        assert db.commit.call_count == 1
        assert notifications == [("success", "t1")]

        # Scalar params sane: sentiment in [-1,1], status parameter present
        update_params = [
            c.args[1] for c in cursor.execute.call_args_list
            if c.args[0].startswith('UPDATE "TrackLyrics"')
        ][0]
        sentiment = update_params[0]
        assert -1.0 <= sentiment <= 1.0
        assert "completed" in update_params

    def test_empty_lyrics_marks_instrumental_not_failed(self):
        worker, db, cursor, embedder, notifications = make_worker(
            {"plainLyrics": "", "syncedLyrics": "[ar:someone]\n[00:01.00]"}
        )

        assert worker._process_job() is True

        params = [c.args for c in cursor.execute.call_args_list]
        instrumental_updates = [
            a for a in params if len(a) > 1 and "instrumental" in a[1]
        ]
        assert len(instrumental_updates) == 1
        assert embedder.embed.not_called
        assert notifications == []

    def test_embed_failure_marks_failed_and_notifies(self):
        worker, db, cursor, embedder, notifications = make_worker(
            {"plainLyrics": "real lyrics with plenty of words here", "syncedLyrics": None},
            embed_error=RuntimeError("model exploded"),
        )

        assert worker._process_job() is True

        failed_updates = [
            c.args for c in cursor.execute.call_args_list
            if len(c.args) > 1 and "failed" in c.args[1]
        ]
        assert len(failed_updates) == 1
        assert notifications == [("failure", "t1")]

    def test_missing_row_is_acked_without_writes(self):
        worker, db, cursor, embedder, notifications = make_worker(None)

        assert worker._process_job() is True

        # Only the SELECT ran; no UPDATE/INSERT, no commit
        sql_calls = [c.args[0] for c in cursor.execute.call_args_list]
        assert all(s.strip().startswith("SELECT") for s in sql_calls)
        assert db.commit.call_count == 0

    def test_queue_timeout_returns_false(self):
        worker, db, cursor, embedder, notifications = make_worker(
            {"plainLyrics": "x", "syncedLyrics": None}
        )
        worker.redis_client.blpop.return_value = None

        assert worker._process_job() is False
        assert cursor.execute.call_count == 0
