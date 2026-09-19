export class LatestDeliveryRefresh {
  private generation = 0;

  async run<T>(load: () => Promise<T>, apply: (value: T) => void, reject: (error: unknown) => void): Promise<boolean> {
    const generation = ++this.generation;
    try {
      const value = await load();
      if (generation !== this.generation) {
        return false;
      }
      apply(value);
      return true;
    } catch (error) {
      if (generation !== this.generation) {
        return false;
      }
      reject(error);
      return true;
    }
  }
}