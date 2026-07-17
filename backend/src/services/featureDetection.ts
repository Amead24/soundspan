import { existsSync } from "fs";
import { redisClient } from "../utils/redis";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

// Analyzer script paths in the Docker image
const ESSENTIA_ANALYZER_PATH = "/app/audio-analyzer/analyzer.py";
const CLAP_ANALYZER_PATH = "/app/audio-analyzer-clap/analyzer.py";

export interface AvailableFeatures {
    musicCNN: boolean;
    vibeEmbeddings: boolean;
    lyricAnalysis: boolean;
}

const HEARTBEAT_TTL = 300000; // 5 minutes
const CACHE_TTL = 60000; // 60 seconds

class FeatureDetectionService {
    private cache: AvailableFeatures | null = null;
    private lastCheck: number = 0;

    async getFeatures(): Promise<AvailableFeatures> {
        const now = Date.now();
        if (this.cache && now - this.lastCheck < CACHE_TTL) {
            return this.cache;
        }

        const [musicCNN, vibeEmbeddings, lyricAnalysis] = await Promise.all([
            this.checkMusicCNN(),
            this.checkCLAP(),
            this.checkLyricWorker(),
        ]);

        this.cache = { musicCNN, vibeEmbeddings, lyricAnalysis };
        this.lastCheck = now;

        logger.debug(
            `[FEATURE-DETECTION] Features: musicCNN=${musicCNN}, vibeEmbeddings=${vibeEmbeddings}, lyricAnalysis=${lyricAnalysis}`
        );

        return this.cache;
    }

    private async checkMusicCNN(): Promise<boolean> {
        try {
            // Analyzer script bundled in image = feature is available
            if (existsSync(ESSENTIA_ANALYZER_PATH)) {
                return true;
            }

            const heartbeat = await redisClient.get("audio:worker:heartbeat");
            if (heartbeat) {
                const timestamp = parseInt(heartbeat, 10);
                if (!isNaN(timestamp) && Date.now() - timestamp < HEARTBEAT_TTL) {
                    return true;
                }
            }

            const trackWithEnergy = await prisma.track.findFirst({
                where: { energy: { not: null } },
                select: { id: true },
            });
            return trackWithEnergy !== null;
        } catch (error) {
            logger.error("[FEATURE-DETECTION] Error checking MusicCNN:", error);
            return false;
        }
    }

    private async checkCLAP(): Promise<boolean> {
        try {
            // Analyzer script bundled in image = feature is available
            if (existsSync(CLAP_ANALYZER_PATH)) {
                return true;
            }

            const heartbeat = await redisClient.get("clap:worker:heartbeat");
            if (heartbeat) {
                const timestamp = parseInt(heartbeat, 10);
                if (!isNaN(timestamp) && Date.now() - timestamp < HEARTBEAT_TTL) {
                    return true;
                }
            }

            const embeddingCount = await prisma.trackEmbedding.count();
            return embeddingCount > 0;
        } catch (error) {
            logger.error("[FEATURE-DETECTION] Error checking CLAP:", error);
            return false;
        }
    }

    private async checkLyricWorker(): Promise<boolean> {
        try {
            // Heartbeat only — deliberately no bundled-script or DB-evidence
            // fallback. The lyric worker rides inside the CLAP sidecar image,
            // so the CLAP script existing on disk proves nothing about THIS
            // image carrying the worker, and past DB results don't mean
            // anything can drain the queue today. The sole consumer is
            // enrichment queueing, which must never flip rows to
            // "processing" that no live worker will consume.
            const heartbeat = await redisClient.get("lyrics:worker:heartbeat");
            if (heartbeat) {
                const timestamp = parseInt(heartbeat, 10);
                return !isNaN(timestamp) && Date.now() - timestamp < HEARTBEAT_TTL;
            }
            return false;
        } catch (error) {
            logger.error(
                "[FEATURE-DETECTION] Error checking lyric worker:",
                error
            );
            return false;
        }
    }

    invalidateCache(): void {
        this.cache = null;
        this.lastCheck = 0;
    }
}

export const featureDetection = new FeatureDetectionService();
