/**
 * 极简 ZIP 打包工具（STORE 不压缩，无第三方依赖）
 * 生成标准 zip 结构，可被系统自带解压工具直接打开。
 */

// CRC32 查表
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * 生成 zip 内唯一文件名（处理同名冲突）
 * @param {string} name
 * @param {Set<string>} used 已占用名称（小写）
 * @returns {string}
 */
function uniqueName(name, used) {
  const sanitized = (name || '').replace(/[\\/:*?"<>|]/g, '_');
  const dot = sanitized.lastIndexOf('.');
  const hasExt = dot > 0;
  const base = hasExt ? sanitized.slice(0, dot) : sanitized;
  const ext = hasExt ? sanitized.slice(dot) : '';

  let candidate = sanitized || 'unnamed';
  let counter = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base} (${counter})${ext}`;
    counter++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * 为条目预分配 zip 内文件名（manifest 等保留名优先占用）
 * @param {Array<{name: string}>} entries
 * @param {string[]} reserved 需要保留的文件名
 */
export function reserveZipNames(entries, reserved = []) {
  const used = new Set(reserved.map((n) => n.toLowerCase()));
  entries.forEach((entry) => {
    entry.zipName = uniqueName(entry.name, used);
  });
  return entries;
}

function buildLocalHeader(entry, nameBytes) {
  const buf = new ArrayBuffer(30);
  const v = new DataView(buf);
  v.setUint32(0, 0x04034b50, true); // 本地文件头签名
  v.setUint16(4, 20, true);        // 解压所需版本
  v.setUint16(6, 0x0800, true);    // 通用位标记：使用 UTF-8 文件名
  v.setUint16(8, 0, true);         // 压缩方式：0=存储
  v.setUint16(10, 0, true);        // 修改时间
  v.setUint16(12, 0x21, true);     // 修改日期：1980-01-01
  v.setUint32(14, entry.crc, true);
  v.setUint32(18, entry.size, true); // 压缩后大小
  v.setUint32(22, entry.size, true); // 原始大小
  v.setUint16(26, nameBytes.length, true);
  v.setUint16(28, 0, true);        // 扩展字段长度
  return new Uint8Array(buf);
}

function buildCentralHeader(entry, nameBytes, localOffset) {
  const buf = new ArrayBuffer(46);
  const v = new DataView(buf);
  v.setUint32(0, 0x02014b50, true); // 中央目录签名
  v.setUint16(4, 20, true);         // 打包版本
  v.setUint16(6, 20, true);         // 解压所需版本
  v.setUint16(8, 0x0800, true);     // UTF-8 标记
  v.setUint16(10, 0, true);         // 存储
  v.setUint16(12, 0, true);
  v.setUint16(14, 0x21, true);
  v.setUint32(16, entry.crc, true);
  v.setUint32(20, entry.size, true);
  v.setUint32(24, entry.size, true);
  v.setUint16(28, nameBytes.length, true);
  v.setUint16(30, 0, true);         // 扩展字段
  v.setUint16(32, 0, true);         // 注释
  v.setUint16(34, 0, true);         // 磁盘编号
  v.setUint16(36, 0, true);         // 内部属性
  v.setUint32(38, 0, true);         // 外部属性
  v.setUint32(42, localOffset, true);
  return new Uint8Array(buf);
}

function buildEndOfCentralDirectory(entryCount, cdSize, cdOffset) {
  const buf = new ArrayBuffer(22);
  const v = new DataView(buf);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(4, 0, true);
  v.setUint16(6, 0, true);
  v.setUint16(8, entryCount, true);
  v.setUint16(10, entryCount, true);
  v.setUint32(12, cdSize, true);
  v.setUint32(16, cdOffset, true);
  v.setUint16(20, 0, true);
  return new Uint8Array(buf);
}

/**
 * 将多个文件打包为 ZIP Blob
 * @param {Array<{name: string, zipName?: string, blob: Blob}>} entries
 * @returns {Promise<Blob>}
 */
export async function createZip(entries) {
  const encoder = new TextEncoder();

  // 若未预分配文件名则就地分配
  if (entries.some((e) => !e.zipName)) {
    reserveZipNames(entries);
  }

  const prepared = [];
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.zipName);
    // CRC32 需要遍历字节，文件较小时可接受
    const buffer = await entry.blob.arrayBuffer();
    prepared.push({
      zipName: entry.zipName,
      nameBytes,
      data: entry.blob,
      size: entry.blob.size,
      crc: crc32(new Uint8Array(buffer))
    });
  }

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of prepared) {
    localChunks.push(buildLocalHeader(entry, entry.nameBytes));
    localChunks.push(entry.nameBytes);
    localChunks.push(entry.data);

    centralChunks.push(buildCentralHeader(entry, entry.nameBytes, offset));
    centralChunks.push(entry.nameBytes);

    offset += 30 + entry.nameBytes.length + entry.size;
  }

  const centralDirectory = new Blob(centralChunks);
  const cdSize = prepared.reduce(
    (sum, e) => sum + 46 + e.nameBytes.length, 0
  );
  const endRecord = buildEndOfCentralDirectory(prepared.length, cdSize, offset);

  return new Blob([...localChunks, centralDirectory, endRecord], {
    type: 'application/zip'
  });
}

/**
 * 触发浏览器下载
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 延迟释放，确保下载已开始
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
