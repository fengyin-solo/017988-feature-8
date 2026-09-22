import { Logger } from '../utils/logger.js';

const logger = new Logger('ZipWriter');

/**
 * 轻量级 ZIP 打包工具（仅存储模式 store，不压缩）
 * 用于把待分析清单中的多个音频文件打包成 zip 留档，无需第三方依赖。
 * entries: [{ name: string, data: Uint8Array|ArrayBuffer|Blob }]
 * 返回 Blob (application/zip)
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** JS Date -> DOS 时间（16 位） */
function dosTime(date) {
  return ((date.getHours() & 0x1f) << 11) |
         ((date.getMinutes() & 0x3f) << 5) |
         ((Math.floor(date.getSeconds() / 2)) & 0x1f);
}

/** JS Date -> DOS 日期（16 位） */
function dosDate(date) {
  return (((date.getFullYear() - 1980) & 0x7f) << 9) |
         (((date.getMonth() + 1) & 0x0f) << 5) |
         (date.getDate() & 0x1f);
}

function u16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function u32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

/**
 * 打包文件
 * @param {Array<{name: string, data: Uint8Array|ArrayBuffer|Blob, date?: Date}>} entries
 * @returns {Promise<Blob>}
 */
export async function buildZip(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const centralRecords = [];
  let offset = 0;
  const now = new Date();

  for (const entry of entries) {
    let bytes = entry.data;
    if (bytes instanceof Blob) {
      bytes = new Uint8Array(await bytes.arrayBuffer());
    } else if (bytes instanceof ArrayBuffer) {
      bytes = new Uint8Array(bytes);
    } else if (ArrayBuffer.isView(bytes)) {
      bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } else {
      throw new Error(`无法打包条目: ${entry.name}`);
    }

    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(bytes);
    const size = bytes.length;
    const modDate = entry.date || now;
    const time = dosTime(modDate);
    const date = dosDate(modDate);

    // 本地文件头 (30 字节 + 文件名)
    const localHeader = new ArrayBuffer(30);
    const lv = new DataView(localHeader);
    u32(lv, 0, 0x04034b50);            // 本地文件头签名
    u16(lv, 4, 20);                    // 解压所需版本
    u16(lv, 6, 0x0800);                // 标志位：bit11 = UTF-8 文件名
    u16(lv, 8, 0);                     // 压缩方式：存储
    u16(lv, 10, time);
    u16(lv, 12, date);
    u32(lv, 14, crc);
    u32(lv, 18, size);                 // 压缩后大小
    u32(lv, 22, size);                 // 原始大小
    u16(lv, 26, nameBytes.length);
    u16(lv, 28, 0);                    // 扩展字段长度

    chunks.push(new Uint8Array(localHeader), nameBytes, bytes);

    // 中央目录记录 (46 字节 + 文件名)
    const central = new ArrayBuffer(46);
    const cv = new DataView(central);
    u32(cv, 0, 0x02014b50);            // 中央目录签名
    u16(cv, 4, 20);                    // 制作版本
    u16(cv, 6, 20);                    // 解压所需版本
    u16(cv, 8, 0x0800);                // UTF-8 标志
    u16(cv, 10, 0);
    u16(cv, 12, time);
    u16(cv, 14, date);
    u32(cv, 16, crc);
    u32(cv, 20, size);
    u32(cv, 24, size);
    u16(cv, 28, nameBytes.length);
    u16(cv, 30, 0);                    // 扩展字段长度
    u16(cv, 32, 0);                    // 注释长度
    u16(cv, 34, 0);                    // 磁盘编号
    u16(cv, 36, 0);                    // 内部属性
    u32(cv, 38, 0);                    // 外部属性
    u32(cv, 42, offset);               // 本地文件头偏移

    centralRecords.push({ header: new Uint8Array(central), name: nameBytes });

    offset += 30 + nameBytes.length + size;
  }

  const centralStart = offset;
  for (const record of centralRecords) {
    chunks.push(record.header, record.name);
    offset += record.header.length + record.name.length;
  }
  const centralSize = offset - centralStart;

  // 中央目录结束记录 (EOCD, 22 字节)
  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  u32(ev, 0, 0x06054b50);
  u16(ev, 4, 0);
  u16(ev, 6, 0);
  u16(ev, 8, centralRecords.length);
  u16(ev, 10, centralRecords.length);
  u32(ev, 12, centralSize);
  u32(ev, 16, centralStart);
  u16(ev, 20, 0);
  chunks.push(new Uint8Array(eocd));

  logger.info('打包完成', { files: entries.length, bytes: offset });
  return new Blob(chunks, { type: 'application/zip' });
}
