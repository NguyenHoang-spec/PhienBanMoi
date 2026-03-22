import { pipeline, env } from '@xenova/transformers';

// Disable local models to force downloading from huggingface
env.allowLocalModels = false;

class LocalEmbeddingService {
    private extractor: any = null;
    private isInitializing = false;
    private initPromise: Promise<void> | null = null;

    private async init() {
        if (this.extractor) return;
        if (this.initPromise) return this.initPromise;

        this.isInitializing = true;
        this.initPromise = new Promise(async (resolve, reject) => {
            try {
                console.log("[Hệ thống Ký ức] Đang tải mô hình AI cục bộ (Local Embedding)...");
                // Use a small, fast model for browser embedding
                this.extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
                console.log("[Hệ thống Ký ức] Tải mô hình thành công!");
                resolve();
            } catch (error) {
                console.error("[Hệ thống Ký ức] Lỗi tải mô hình:", error);
                reject(error);
            } finally {
                this.isInitializing = false;
            }
        });

        return this.initPromise;
    }

    /**
     * Generates a vector embedding using local browser AI.
     * Model: Xenova/all-MiniLM-L6-v2 (384 dimensions)
     */
    async embedText(text: string): Promise<number[]> {
        if (!text || text.trim().length === 0) return [];

        try {
            await this.init();
            
            if (!this.extractor) {
                console.warn("⚠️ [Hệ thống Ký ức] Mô hình chưa sẵn sàng.");
                return [];
            }

            const output = await this.extractor(text, { pooling: 'mean', normalize: true });
            
            // output.data is a Float32Array, convert to regular array
            return Array.from(output.data);
        } catch (e: any) {
            console.error("⚠️ [Hệ thống Ký ức] Lỗi tạo Local Embedding:", e);
            return [];
        }
    }

    // Alias for backward compatibility with existing code
    async embedTextLocal(text: string): Promise<number[]> {
        return this.embedText(text);
    }
}

export const localEmbeddingService = new LocalEmbeddingService();
