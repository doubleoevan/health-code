type ForEachConcurrentlyOptions<Item> = {
	items: readonly Item[]
	concurrency: number
	work: (item: Item) => Promise<void>
}

/**
 * Performs work on every item with a bounded number of items in flight.
 */
export async function forEachConcurrently<Item>({
	items,
	concurrency,
	work,
}: ForEachConcurrentlyOptions<Item>): Promise<void> {
	const pending = items.values()

	// share the queue so a slow item occupies only one worker
	async function worker(): Promise<void> {
		for (const item of pending) {
			await work(item)
		}
	}
	await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, worker))
}
