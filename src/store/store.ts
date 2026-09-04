interface Entry {
    value: string;
    expiresAt: number | null; // in milliseconds since epoch
}

export class Store {
    private data = new Map<string, Entry>();
    private sweepTimer: NodeJS.Timeout | null = null;

    constructor() {
        this.sweepTimer = setInterval(() => this.activeExpireCycle(), 200);
        this.sweepTimer.unref();
    }

    private isExpired(entry: Entry): boolean {
        return entry.expiresAt !== null && entry.expiresAt <= Date.now();
    }

    private activeExpireCycle(): void {
        const sampleSize = 20;
        let count = 0;
        for(const [key, entry] of this.data){
            if(count++ >= sampleSize) break;
            if(this.isExpired(entry)){
                this.data.delete(key);
            }
        }
    }

    expire(key: string, ttlMs: number): boolean {
        const entry = this.data.get(key);
        if (!entry || this.isExpired(entry)) return false;
        entry.expiresAt = Date.now() + ttlMs;
        return true;
    }

    set(key: string, value: string, ttlMl?: number): void {
        this.data.set(key, {
            value,
            expiresAt: ttlMl ? Date.now() + ttlMl : null,
        });
    }

    get(key: string): string | null {
        const entry = this.data.get(key);
        if(!entry) return null;

        if(this.isExpired(entry)){
            this.data.delete(key);
            return null;
        }

        return entry.value;
    }

    del(keys: string[]): number {
        let count = 0;

        for (const key of keys) {
            if (this.data.delete(key)) count++;
        }

        return count;
    }

    size(): number {
        return this.data.size;
    }

    ttlMs(key: string): number | null{
        const entry = this.data.get(key);
        if(!entry || this.isExpired(entry)) return null;
        if(entry.expiresAt === null) return -1;
        return entry.expiresAt - Date.now();
    }
}