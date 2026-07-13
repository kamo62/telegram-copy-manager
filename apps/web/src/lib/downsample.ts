/**
 * Retain the first/last value plus each bucket's low and high in chronological
 * order. Unlike point averaging, this keeps peaks and drawdown depth visible.
 */
export function downsample(values: number[], maxPoints: number): number[] {
  if (values.length <= maxPoints) return values;
  return downsampleIndices(values, maxPoints).map((index) => values[index] as number);
}

/** Returns the retained positions so paired x/y chart series stay aligned. */
export function downsampleIndices(values: number[], maxPoints: number): number[] {
  const target = Math.max(0, Math.floor(maxPoints));
  if (values.length <= target) return values.map((_value, index) => index);
  if (target === 0) return [];

  const lastIndex = values.length - 1;
  let lowIndex = 0;
  let highIndex = 0;
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] as number) < (values[lowIndex] as number)) lowIndex = index;
    if ((values[index] as number) > (values[highIndex] as number)) highIndex = index;
  }
  if (target === 1) return [lowIndex];

  const selected = new Set([lowIndex, highIndex]);
  if (selected.size < target) selected.add(0);
  if (selected.size < target) selected.add(lastIndex);

  const remaining = target - selected.size;
  const bucketCount = Math.floor(remaining / 2);
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = 1 + Math.floor((bucket * (values.length - 2)) / bucketCount);
    const end = 1 + Math.floor(((bucket + 1) * (values.length - 2)) / bucketCount);
    let bucketLow = start;
    let bucketHigh = start;
    for (let index = start + 1; index < end; index += 1) {
      if ((values[index] as number) < (values[bucketLow] as number)) bucketLow = index;
      if ((values[index] as number) > (values[bucketHigh] as number)) bucketHigh = index;
    }
    selected.add(bucketLow);
    selected.add(bucketHigh);
  }

  if (selected.size < target) {
    selected.add(Math.floor(lastIndex / 2));
  }
  for (let slot = 1; selected.size < target && slot < target; slot += 1) {
    selected.add(Math.floor((slot * lastIndex) / target));
  }
  return [...selected].sort((a, b) => a - b).slice(0, target);
}
