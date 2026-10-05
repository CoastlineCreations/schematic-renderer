type Position = [number, number, number];
type Kind = "added" | "removed" | "changed" | "swapped" | "mixed";

interface ChangeRegion {
	min: Position;
	max: Position;
	kind: Kind;
	count: number;
}

/** Reconstruct the legacy complete region list; native summaries can truncate large diffs. */
export function diffRegions(diffJson: string): ChangeRegion[] {
	const diff = JSON.parse(diffJson) as Record<Exclude<Kind, "mixed">, Array<{ pos: Position }>>;
	const remaining = new Map<string, { pos: Position; kind: Kind }>();
	for (const kind of ["added", "removed", "changed", "swapped"] as const) {
		for (const change of diff[kind]) {
			const key = change.pos.join(",");
			const existing = remaining.get(key);
			remaining.set(key, {
				pos: change.pos,
				kind: existing && existing.kind !== kind ? "mixed" : kind,
			});
		}
	}

	const regions: ChangeRegion[] = [];
	while (remaining.size) {
		const first = remaining.values().next().value;
		if (!first) break;
		const region: ChangeRegion = {
			min: [...first.pos],
			max: [...first.pos],
			kind: first.kind,
			count: 0,
		};
		const pending = [first];
		remaining.delete(first.pos.join(","));
		for (let index = 0; index < pending.length; index++) {
			const current = pending[index];
			region.count++;
			if (current.kind !== region.kind) region.kind = "mixed";
			for (let axis = 0; axis < 3; axis++) {
				region.min[axis] = Math.min(region.min[axis], current.pos[axis]);
				region.max[axis] = Math.max(region.max[axis], current.pos[axis]);
				for (const offset of [-1, 1]) {
					const neighbour: Position = [...current.pos];
					neighbour[axis] += offset;
					const key = neighbour.join(",");
					const change = remaining.get(key);
					if (change) {
						remaining.delete(key);
						pending.push(change);
					}
				}
			}
		}
		regions.push(region);
	}
	return regions.sort((a, b) => a.min[0] - b.min[0] || a.min[1] - b.min[1] || a.min[2] - b.min[2]);
}
