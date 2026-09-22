import { Logger } from '../utils/logger.js';

const logger = new Logger('FileQueueStore');

/**
 * 待分析文件清单管理
 * - 使用 IndexedDB 持久化文件 Blob 与元数据，重新打开页面后清单仍然可见
 * - 支持批量加入、去重、逐条校验（格式 / 读取失败）、重试、移除、替换
 *
 * 条目结构:
 * {
 *   id, name, size, lastModified, format, durationMs,
 *   status: 'reading' | 'ready' | 'error',
 *   error: null | 'unsupported' | 'decode' | 'read',
 *   errorMessage: string | null,
 *   analyzed: boolean,
 *   addedAt, file: Blob(仅 IndexedDB，不在事件 payload 中)
 * }
 */

const DB_NAME = 'guqin_audio_uploads';
const DB_VERSION = 2;
const STORE = 'pending_files';
const BLOB_STORE = 'pending_blobs';

// 支持的音频扩展名（与浏览器可解码能力对齐）
const SUPPORTED_EXTENSIONS = new Set([
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'webm', 'weba', 'opus'
]);

export class FileQueueStore extends EventTarget {
  constructor() {
    super();
    this.db = null;
    this.items = []; // 元数据（不含 Blob），file 仅在需要时通过 getFile 获取
  }

  /**
   * 打开数据库并加载已有清单
   */
  async init() {
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        // 元数据与文件 Blob 分库存放，避免更新状态时覆盖丢失 Blob
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(BLOB_STORE)) {
          db.createObjectStore(BLOB_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    this.items = await new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const rows = (req.result || [])
          .map(row => {
            const { file, ...meta } = row;
            return meta;
          })
          .sort((a, b) => a.addedAt - b.addedAt);
        resolve(rows);
      };
      req.onerror = () => reject(req.error);
    });

    logger.info('加载待分析清单', { count: this.items.length });
  }

  getItems() {
    return this.items;
  }

  getReadyItems() {
    return this.items.filter(item => item.status === 'ready');
  }

  getItem(id) {
    return this.items.find(item => item.id === id) || null;
  }

  getFile(id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(BLOB_STORE, 'readonly');
      const req = tx.objectStore(BLOB_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * 计算文件指纹（名称 + 大小 + 修改时间）
   */
  fingerprint({ name, size, lastModified }) {
    return `${name}|${size}|${lastModified || 0}`;
  }

  /**
   * 批量加入文件。重复文件（清单中已存在）会被跳过。
   * @param {File[]} fileList
   * @param {{decode: Function, isAnalyzed?: Function}} options
   * @returns {{added: string[], duplicates: string[]}}
   */
  async addFiles(fileList, { decode, isAnalyzed }) {
    const existing = new Set(this.items.map(item =>
      this.fingerprint(item)
    ));

    const added = [];
    const duplicates = [];

    for (const file of fileList) {
      const fp = this.fingerprint(file);
      if (existing.has(fp)) {
        duplicates.push(file.name);
        continue;
      }
      existing.add(fp);

      const id = this.generateId();
      const ext = (file.name.includes('.') ? file.name.split('.').pop() : '').toLowerCase();
      const item = {
        id,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified || 0,
        format: ext ? ext.toUpperCase() : '未知',
        durationMs: null,
        status: 'reading',
        error: null,
        errorMessage: null,
        analyzed: typeof isAnalyzed === 'function' ? !!isAnalyzed(file) : false,
        addedAt: Date.now() + added.length
      };

      await this.persist({ ...item, file });
      this.items.push(item);
      added.push(id);
      this.emitChange();

      // 不 await，逐条校验，避免一个失败拖慢整批
      this.validateItem(id, file, decode).catch(err => {
        logger.error('校验文件异常', err);
      });
    }

    if (duplicates.length > 0) {
      this.dispatchEvent(new CustomEvent('duplicates', {
        detail: { names: duplicates }
      }));
    }

    return { added, duplicates };
  }

  /**
   * 逐条校验：扩展名白名单 + 实际解码读取
   */
  async validateItem(id, file, decode) {
    const currentItem = this.getItem(id);
    const fileName = file.name || (currentItem ? currentItem.name : '') || '';
    const ext = (fileName.includes('.') ? fileName.split('.').pop() : '').toLowerCase();

    // 空文件
    if (file.size === 0) {
      await this.markError(id, 'read', '文件大小为 0，无法读取音频内容');
      return;
    }

    // MIME 明确不是音频，且扩展名也不在白名单 -> 不尝试解码
    const mime = file.type || '';
    const extOk = SUPPORTED_EXTENSIONS.has(ext);
    if (mime && !mime.startsWith('audio/') && !mime.startsWith('video/') && !extOk) {
      await this.markError(id, 'unsupported', `不支持的格式：.${ext || '未知'}（仅支持 MP3、WAV、OGG、M4A、AAC、FLAC、Opus 等音频）`);
      return;
    }
    if (!mime && !extOk) {
      await this.markError(id, 'unsupported', `不支持的格式：.${ext || '未知'}（仅支持 MP3、WAV、OGG、M4A、AAC、FLAC、Opus 等音频）`);
      return;
    }

    try {
      const arrayBuffer = await file.arrayBuffer();
      if (!this.getItem(id) || this.getItem(id).name !== fileName) return; // 校验期间被移除或替换

      let durationMs = null;
      try {
        const audioBuffer = await decode(arrayBuffer.slice(0));
        durationMs = Math.round(audioBuffer.duration * 1000);
      } catch (decodeErr) {
        logger.warn('音频解码失败', { name: fileName, decodeErr });
        await this.markErrorIfCurrent(id, fileName, 'decode', '音频读取失败：文件已损坏或编码格式不受浏览器支持');
        return;
      }

      if (!this.getItem(id) || this.getItem(id).name !== fileName) return;

      if (durationMs !== null && durationMs <= 0) {
        await this.markErrorIfCurrent(id, fileName, 'decode', '音频时长为 0，内容可能已损坏');
        return;
      }

      const item = this.getItem(id);
      if (!item || item.name !== fileName) return;
      item.status = 'ready';
      item.error = null;
      item.errorMessage = null;
      item.durationMs = durationMs;
      await this.persist(item);
      this.emitChange();
    } catch (err) {
      logger.error('读取文件失败', err);
      await this.markErrorIfCurrent(id, fileName, 'read', `文件读取失败：${err.message || '磁盘或文件访问错误'}`);
    }
  }

  /**
   * 标记错误，仅当条目仍对应本次校验的文件时生效（避免移除/替换竞态）
   */
  async markErrorIfCurrent(id, fileName, error, message) {
    const item = this.getItem(id);
    if (!item || item.name !== fileName) return;
    await this.markError(id, error, message);
  }

  async markError(id, error, message) {
    const item = this.getItem(id);
    if (!item) return;
    item.status = 'error';
    item.error = error;
    item.errorMessage = message;
    await this.persist(item);
    this.emitChange();
  }

  /**
   * 重试失败条目（重新读取文件并解码）
   */
  async retryItem(id, decode) {
    const item = this.getItem(id);
    if (!item || item.status !== 'error') return;

    item.status = 'reading';
    item.error = null;
    item.errorMessage = null;
    await this.persist(item);
    this.emitChange();

    const file = await this.getFile(id);
    if (!file) {
      await this.markError(id, 'read', '文件数据已丢失，请移除后重新添加');
      return;
    }
    await this.validateItem(id, file, decode);
  }

  /**
   * 移除单个条目
   */
  async removeItem(id) {
    const index = this.items.findIndex(item => item.id === id);
    if (index === -1) return;
    this.items.splice(index, 1);
    await this.deletePersisted(id);
    this.emitChange();
  }

  /**
   * 替换条目：保留原 id 与位置，更新文件后重新校验
   */
  async replaceItem(id, file, { decode, isAnalyzed }) {
    const item = this.getItem(id);
    if (!item) return;

    // 与清单中其它条目去重
    const fp = this.fingerprint(file);
    const dup = this.items.some(other => other.id !== id && this.fingerprint(other) === fp);
    if (dup) {
      this.dispatchEvent(new CustomEvent('duplicates', {
        detail: { names: [file.name] }
      }));
      return;
    }

    const ext = (file.name.includes('.') ? file.name.split('.').pop() : '').toLowerCase();
    item.name = file.name;
    item.size = file.size;
    item.lastModified = file.lastModified || 0;
    item.format = ext ? ext.toUpperCase() : '未知';
    item.durationMs = null;
    item.status = 'reading';
    item.error = null;
    item.errorMessage = null;
    item.analyzed = typeof isAnalyzed === 'function' ? !!isAnalyzed(file) : false;

    await this.persist({ ...item, file });
    this.emitChange();
    await this.validateItem(id, file, decode);
  }

  /**
   * 标记已分析
   */
  async markAnalyzed(id, analyzed = true) {
    const item = this.getItem(id);
    if (!item || item.analyzed === analyzed) return;
    item.analyzed = analyzed;
    await this.persist(item);
    this.emitChange();
  }

  /**
   * 清空清单
   */
  async clear() {
    await Promise.all(this.items.map(item => this.deletePersisted(item.id)));
    this.items = [];
    this.emitChange();
  }

  emitChange() {
    this.dispatchEvent(new CustomEvent('change'));
  }

  /**
   * 持久化条目；若携带 file（Blob）则一并写入 Blob 库，仅更新元数据时不会影响文件
   */
  persist(record) {
    return new Promise((resolve, reject) => {
      const { file, ...meta } = record;
      const tx = this.db.transaction([STORE, BLOB_STORE], 'readwrite');
      tx.objectStore(STORE).put(meta);
      if (file) {
        tx.objectStore(BLOB_STORE).put(file, meta.id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  deletePersisted(id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORE, BLOB_STORE], 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.objectStore(BLOB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }
}
