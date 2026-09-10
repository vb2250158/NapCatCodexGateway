export type HotPatchLease = Readonly<{
  revision: number;
  contract: Readonly<Record<string, unknown>>;
  run<T>(operation: () => T): T;
  release(): void;
}>;

export function retainHotPatchResult<T>(result: T, lease: HotPatchLease): T {
  if (result && typeof (result as { then?: unknown }).then === "function") {
    return Promise.resolve(result).then(value => {
      try { return retainHotPatchResult(value, lease); }
      catch (error) { lease.release(); throw error; }
    }, error => {
      lease.release();
      throw error;
    }) as T;
  }
  const tag = Object.prototype.toString.call(result);
  if (tag !== "[object Generator]" && tag !== "[object AsyncGenerator]") {
    lease.release();
    return result;
  }
  const target = result as object;
  let completed = false;
  let pending = 0;
  const methods = new Map<PropertyKey, (...arguments_: unknown[]) => unknown>();
  const settle = () => {
    pending -= 1;
    if (completed && pending === 0) lease.release();
  };
  const finish = (value: unknown) => {
    if (value && typeof value === "object" && (value as { done?: boolean }).done) completed = true;
    settle();
    return value;
  };
  const fail = (error: unknown): never => {
    completed = true;
    settle();
    throw error;
  };
  const proxy = new Proxy(target, {
    get(iterator, property) {
      if (property === Symbol.iterator && tag === "[object Generator]"
        || property === Symbol.asyncIterator && tag === "[object AsyncGenerator]") return () => proxy;
      const member = Reflect.get(iterator, property, iterator);
      if (!["next", "return", "throw"].includes(String(property)) || typeof member !== "function") return member;
      let method = methods.get(property);
      if (!method) {
        method = function(this: unknown, ...arguments_) {
          if (this !== proxy && this !== iterator) return Reflect.apply(member, this, arguments_);
          if (tag === "[object Generator]" && pending > 0) throw new TypeError("Generator is already running");
          if (completed && pending === 0) return Reflect.apply(member, iterator, arguments_);
          pending += 1;
          try {
            const value = lease.run(() => Reflect.apply(member, iterator, arguments_));
            return value && typeof (value as { then?: unknown }).then === "function"
              ? Promise.resolve(value).then(finish, fail) : finish(value);
          } catch (error) { return fail(error); }
        };
        methods.set(property, method);
      }
      return method;
    }
  });
  return proxy as T;
}
