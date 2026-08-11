export function requireAt<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) {
    throw new Error(
      `requireAt: index ${String(index)} is out of bounds (length ${String(array.length)})`,
    );
  }
  return value;
}
