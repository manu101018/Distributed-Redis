export class Store {
    private data = new Map<string, string>();

    set(key: string, value: string): void {
        this.data.set(key, value);
    }

    get(key: string): string | null {
        return this.data.get(key) ?? null;
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
}