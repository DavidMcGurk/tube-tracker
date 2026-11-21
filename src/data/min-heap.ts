/** A binary min-heap of numeric values keyed by numeric priority. */
export class MinHeap {
  private readonly keys: number[] = [];
  private readonly values: number[] = [];

  get size() {
    return this.keys.length;
  }

  push(key: number, value: number) {
    const { keys, values } = this;
    let index = keys.length;
    keys.push(key);
    values.push(value);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (keys[parent]! <= key) break;
      keys[index] = keys[parent]!;
      values[index] = values[parent]!;
      index = parent;
    }
    keys[index] = key;
    values[index] = value;
  }

  /** Removes and returns the value with the lowest key. Call only when size > 0. */
  pop(): number {
    const { keys, values } = this;
    const top = values[0]!;
    const lastKey = keys.pop()!;
    const lastValue = values.pop()!;
    const size = keys.length;
    if (size > 0) {
      let index = 0;
      for (;;) {
        let child = 2 * index + 1;
        if (child >= size) break;
        if (child + 1 < size && keys[child + 1]! < keys[child]!) child += 1;
        if (keys[child]! >= lastKey) break;
        keys[index] = keys[child]!;
        values[index] = values[child]!;
        index = child;
      }
      keys[index] = lastKey;
      values[index] = lastValue;
    }
    return top;
  }
}
