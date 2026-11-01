import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import {
  InvalidPhoneNumberError,
  createIndexedDbStorage,
  createWebDialler,
  createWebNotifications,
  telUrl,
} from '../src';

describe('storage adapter (IndexedDB)', () => {
  const fresh = () => createIndexedDbStorage({ indexedDB: new IDBFactory() });

  it('stores, reads, lists and removes values', async () => {
    const storage = fresh();
    expect(await storage.get('a')).toBeUndefined();
    await storage.set('a', { n: 1, list: [1, 2] });
    await storage.set('b', 'two');
    expect(await storage.get('a')).toEqual({ n: 1, list: [1, 2] });
    expect((await storage.keys()).sort()).toEqual(['a', 'b']);
    await storage.remove('a');
    expect(await storage.get('a')).toBeUndefined();
    expect(await storage.keys()).toEqual(['b']);
  });

  it('overwrites a key and clears everything', async () => {
    const storage = fresh();
    await storage.set('k', 1);
    await storage.set('k', 2);
    expect(await storage.get('k')).toBe(2);
    await storage.set('other', 3);
    await storage.clear();
    expect(await storage.keys()).toEqual([]);
  });

  describe('a write that is accepted and then rolled back', () => {
    /** Makes every call of `method` succeed as a request and then abort its transaction, as a commit-time failure does. */
    function rollBackAfterSuccess(method: 'put' | 'delete' | 'clear') {
      const original = IDBObjectStore.prototype[method] as (...args: unknown[]) => IDBRequest;
      return vi.spyOn(IDBObjectStore.prototype, method as 'put').mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
        const request = original.apply(this, args);
        request.addEventListener('success', () => this.transaction.abort());
        return request;
      } as never);
    }

    it('set rejects, because the value was not committed', async () => {
      const storage = fresh();
      await storage.set('k', 'before');
      const spy = rollBackAfterSuccess('put');
      await expect(storage.set('k', 'after')).rejects.toThrow();
      spy.mockRestore();
      expect(await storage.get('k')).toBe('before');
    });

    it('remove rejects, because the value is still there', async () => {
      const storage = fresh();
      await storage.set('k', 'kept');
      const spy = rollBackAfterSuccess('delete');
      await expect(storage.remove('k')).rejects.toThrow();
      spy.mockRestore();
      expect(await storage.get('k')).toBe('kept');
    });

    it('clear rejects, because nothing was removed', async () => {
      const storage = fresh();
      await storage.set('k', 'kept');
      const spy = rollBackAfterSuccess('clear');
      await expect(storage.clear()).rejects.toThrow();
      spy.mockRestore();
      expect(await storage.keys()).toEqual(['k']);
    });
  });

  it('setIfAbsent stores a missing key and returns the value', async () => {
    const storage = fresh();
    expect(await storage.setIfAbsent('k', 'first')).toBe('first');
    expect(await storage.get('k')).toBe('first');
  });

  it('setIfAbsent leaves an existing value alone and returns it', async () => {
    const storage = fresh();
    await storage.set('k', 'kept');
    expect(await storage.setIfAbsent('k', 'ignored')).toBe('kept');
    expect(await storage.get('k')).toBe('kept');
  });

  it('setIfAbsent lets only the first of many racing callers write', async () => {
    const storage = fresh();
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((v) => storage.setIfAbsent('k', v)));
    expect(new Set(results).size).toBe(1);
    expect(await storage.get('k')).toBe(results[0]);
  });

  it('setIfAbsent rejects when the database cannot be opened', async () => {
    const broken = {
      open() {
        const req: { onerror?: () => void; error: Error } = { error: new Error('no storage') };
        queueMicrotask(() => req.onerror?.());
        return req;
      },
    } as unknown as IDBFactory;
    await expect(createIndexedDbStorage({ indexedDB: broken }).setIfAbsent('k', 1)).rejects.toThrow('no storage');
  });

  it('keeps separate databases apart', async () => {
    const factory = new IDBFactory();
    const one = createIndexedDbStorage({ indexedDB: factory, dbName: 'one' });
    const two = createIndexedDbStorage({ indexedDB: factory, dbName: 'two' });
    await one.set('k', 'from one');
    expect(await two.get('k')).toBeUndefined();
  });

  it('persists across adapter instances on the same database', async () => {
    const factory = new IDBFactory();
    await createIndexedDbStorage({ indexedDB: factory }).set('k', 'kept');
    expect(await createIndexedDbStorage({ indexedDB: factory }).get('k')).toBe('kept');
  });

  it('rejects when the database cannot be opened', async () => {
    const broken = {
      open() {
        const req: { onerror?: () => void; error: Error } = { error: new Error('no storage') };
        queueMicrotask(() => req.onerror?.());
        return req;
      },
    } as unknown as IDBFactory;
    await expect(createIndexedDbStorage({ indexedDB: broken }).get('k')).rejects.toThrow('no storage');
  });

  it('rejects when opening is blocked', async () => {
    const blocked = {
      open() {
        const req: { onblocked?: () => void } = {};
        queueMicrotask(() => req.onblocked?.());
        return req;
      },
    } as unknown as IDBFactory;
    await expect(createIndexedDbStorage({ indexedDB: blocked }).get('k')).rejects.toThrow(/blocked/);
  });
});

describe('dialler adapter', () => {
  it('builds tel: URLs for dialable numbers', () => {
    expect(telUrl('800725462')).toBe('tel:800725462');
    expect(telUrl('999')).toBe('tel:999');
    expect(telUrl('+97124000000')).toBe('tel:+97124000000');
  });

  it('refuses anything that is not a number, so a link cannot smuggle in other schemes', () => {
    for (const bad of ['', '12', 'javascript:alert(1)', '800 725 462', '800-725462', '999;rm', '+', '1234567890123456']) {
      expect(() => telUrl(bad)).toThrow(InvalidPhoneNumberError);
    }
    expect(new InvalidPhoneNumberError('x').name).toBe('InvalidPhoneNumberError');
  });

  it('navigates through the injected function', () => {
    const navigate = vi.fn();
    createWebDialler(navigate).dial('998');
    expect(navigate).toHaveBeenCalledWith('tel:998');
  });

  it('does not navigate for a bad number', () => {
    const navigate = vi.fn();
    expect(() => createWebDialler(navigate).dial('nope')).toThrow(InvalidPhoneNumberError);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('notification adapter', () => {
  function fakeNotification(permission: NotificationPermission) {
    const created: unknown[][] = [];
    class Fake {
      static permission = permission;
      static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
      constructor(...args: unknown[]) {
        created.push(args);
      }
    }
    return { Fake, created };
  }

  it('reports unsupported when the browser has no Notification API', async () => {
    const adapter = createWebNotifications(undefined);
    expect(adapter.permission()).toBe('unsupported');
    expect(await adapter.requestPermission()).toBe('unsupported');
    await expect(adapter.show({ title: 't' })).resolves.toBeUndefined();
  });

  it('shows nothing until permission is granted', async () => {
    const { Fake, created } = fakeNotification('default');
    const adapter = createWebNotifications(Fake as never);
    await adapter.show({ title: 'Did you get seen?' });
    expect(created).toEqual([]);
    expect(await adapter.requestPermission()).toBe('granted');
  });

  it('shows through the page when granted and no service worker is given', async () => {
    const { Fake, created } = fakeNotification('granted');
    await createWebNotifications(Fake as never).show({ title: 'T', body: 'B', tag: 'x' });
    expect(created).toEqual([['T', { body: 'B', tag: 'x' }]]);
  });

  it('shows through the service worker registration when one is given', async () => {
    const { Fake, created } = fakeNotification('granted');
    const showNotification = vi.fn(async () => undefined);
    const adapter = createWebNotifications(Fake as never, { showNotification });
    expect(adapter.permission()).toBe('granted');
    await adapter.show({ title: 'T' });
    expect(showNotification).toHaveBeenCalledWith('T', { body: undefined, tag: undefined });
    expect(created).toEqual([]);
  });
});
