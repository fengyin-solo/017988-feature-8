import { Logger } from '../utils/logger.js';

const logger = new Logger('FileQueueManager');

const DB_NAME = 'guqin_audio_queue_db';
const DB_VERSION = 1;
const STORE_NAME = 'pending_files';
const QUEUE_KEY = 'guqin_audio_queue_meta';

/**
 * 待分析文件队列管理器
 * 使用 IndexedDB 持久化文件 Blob，重新打开页面后清单仍然可见。
 *
 * 条目结构：
 * {
 *   id, name, size, type, ext,
 *   blob: Blob,
 *   status: 'reading' | 'ready' | 'error',
 *   duration: number|null,   // 秒
 *   errorReason: string,
 *   analyzedAt: number|null, // 是否已分析
 *   addedAt: number
 * }
 */
export class FileQueueManager {
  constructor() {
    this.items = [];
    this.db = null;
    this.idSeq = 0;
  }

  /**
   * 初始化：打开 IndexedDB 并恢复清单元数据
   */
  async init() {
    this.db = await this.openDB();
    this.items = this.loadMeta();

    // 清理 IndexedDB 中存在但元数据已丢失的文件
    const blobs = await this.getAllBlobs();
    const ids = new Set(this.items.map((item) => item.id));
    await Promise.all(
      blobs
        .filter((key) => !ids.has(key))
        .map((key) => this.deleteBlob(key))
    );

    const maxSeq = this.items.reduce((max, item) => {
      const seq = parseInt(item.id.split('-')[1], 10);
      return Number.isFinite(seq) ? Math.max(max, seq) : max;
    }, 0);
    this.idSeq = maxSeq;

    logger.info('待分析清单恢复完成', { count: this.items.length });
    return this.items;
  }

  openDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('当前浏览器不支持 IndexedDB，清单无法持久化'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  tx(mode) {
    return this.db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  }

  putBlob(id, blob) {
    return new Promise((resolve, reject) => {
      const request = this.tx('readwrite').put(blob, id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  getBlob(id) {
    return new Promise((resolve, reject) => {
      const request = this.tx('readonly').get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  getAllBlobs() {
    return new Promise((resolve, reject) => {
      const request = this.tx('readonly').getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  deleteBlob(id) {
    return new Promise((resolve, reject) => {
      const request = this.tx('readwrite').delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  loadMeta() {
    try {
      const data = localStorage.getItem(QUEUE_KEY);
      if (!data) return [];
      const items = JSON.parse(data);
      return Array.isArray(items) ? items : [];
    } catch (error) {
      logger.error('加载清单元数据失败', error);
      return [];
    }
  }

  saveMeta() {
    try {
      // 不持久化 blob，blob 存于 IndexedDB
      const meta = this.items.map(({ blob: _blob, ...rest }) => rest);
      localStorage.setItem(QUEUE_KEY, JSON.stringify(meta));
    } catch (error) {
      logger.error('保存清单元数据失败', error);
      throw new Error('清单保存失败，浏览器存储空间可能已满');
    }
  }

  getItems() {
    return this.items;
  }

  getItem(id) {
    return this.items.find((item) => item.id === id) || null;
  }

  nextId() {
    this.idSeq += 1;
    return `q-${this.idSeq}-${Date.now().toString(36)}`;
  }

  /**
   * 加入一个新条目（含 Blob 持久化）
   * @param {File} file
   * @returns {Promise<Object>} 新条目
   */
  async addFile(file) {
    const item = {
      id: this.nextId(),
      name: file.name,
      size: file.size,
      type: file.type || '',
      ext: this.extractExt(file.name),
      blob: file,
      status: 'reading',
      duration: null,
      errorReason: '',
      analyzedAt: null,
      addedAt: Date.now()
    };

    await this.putBlob(item.id, file);
    this.items.push(item);
    this.saveMeta();
    return item;
  }

  /**
   * 更新条目字段
   */
  update(id, updates) {
    const item = this.getItem(id);
    if (!item) return null;
    Object.assign(item, updates);
    this.saveMeta();
    return item;
  }

  /**
   * 移除条目（同时删除 Blob）
   */
  async remove(id) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    this.saveMeta();
    try {
      await this.deleteBlob(id);
    } catch (error) {
      logger.warn('删除清单文件 Blob 失败', error);
    }
    return true;
  }

  /**
   * 清空清单
   */
  async clear() {
    const ids = this.items.map((item) => item.id);
    this.items = [];
    this.saveMeta();
    await Promise.all(ids.map((id) => this.deleteBlob(id).catch(() => {})));
  }

  /**
   * 替换条目的文件（保留位置与 id）
   * @param {string} id
   * @param {File} file
   */
  async replaceFile(id, file) {
    const item = this.getItem(id);
    if (!item) return null;
    await this.putBlob(id, file);
    Object.assign(item, {
      name: file.name,
      size: file.size,
      type: file.type || '',
      ext: this.extractExt(file.name),
      blob: file,
      status: 'reading',
      duration: null,
      errorReason: '',
      analyzedAt: null,
      addedAt: Date.now()
    });
    this.saveMeta();
    return item;
  }

  /**
   * 清单中是否已存在同名同大小的文件
   */
  hasFile(file) {
    return this.items.some(
      (item) => item.name === file.name && item.size === file.size
    );
  }

  extractExt(name) {
    const index = name.lastIndexOf('.');
    return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
  }

  /**
   * 获取所有可打包的条目（含 Blob）
   */
  async getEntriesWithBlobs() {
    const result = [];
    for (const item of this.items) {
      const blob = item.blob || (await this.getBlob(item.id));
      if (blob) {
        result.push({ id: item.id, name: item.name, blob });
      }
    }
    return result;
  }
}
