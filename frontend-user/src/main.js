import { AudioAnalyzer } from './modules/audioAnalyzer.js';
import { ChartManager } from './modules/chartManager.js';
import { UIController } from './modules/uiController.js';
import { RecordManager } from './modules/recordManager.js';
import { FileQueueManager } from './modules/fileQueueManager.js';
import { createZip, reserveZipNames, downloadBlob } from './utils/zip.js';
import { Logger } from './utils/logger.js';

// 初始化日志
const logger = new Logger('Main');

// 可识别的音频扩展名（type 不可靠时的兜底判断）
const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'mp4', 'aac',
  'flac', 'webm', 'opus', 'wma', 'amr', '3gp', 'aiff', 'aif'
]);

/**
 * 应用初始化
 */
class App {
  constructor() {
    this.audioAnalyzer = null;
    this.chartManager = null;
    this.uiController = null;
    this.recordManager = null;
    this.queueManager = null;
    this.audioContext = null;
    this.currentAnalysisResult = null;
    this.activeItemId = null;
    this.replacingItemId = null;
  }

  async init() {
    logger.info('应用初始化开始');

    try {
      // 初始化 AudioContext
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

      // 初始化模块
      this.audioAnalyzer = new AudioAnalyzer(this.audioContext);
      this.chartManager = new ChartManager();
      this.uiController = new UIController();
      this.recordManager = new RecordManager();
      this.queueManager = new FileQueueManager();

      await this.queueManager.init();

      // 绑定事件
      this.bindEvents();

      // 渲染清单与历史记录
      this.renderQueue();
      this.updateRecordsList();

      // 恢复清单中文件的状态并载入首个文件
      await this.restoreQueue();

      logger.info('应用初始化完成');
    } catch (error) {
      logger.error('应用初始化失败', error);
      alert('应用初始化失败，请刷新页面重试');
    }
  }

  bindEvents() {
    const uploadArea = document.getElementById('uploadArea');
    const audioInput = document.getElementById('audioInput');
    const replaceInput = document.getElementById('replaceInput');

    // 点击上传区域 → 批量选择
    uploadArea.addEventListener('click', () => {
      this.resumeAudioContext();
      audioInput.click();
    });
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('dragover');
    });
    uploadArea.addEventListener('dragleave', () => {
      uploadArea.classList.remove('dragover');
    });
    uploadArea.addEventListener('drop', async (e) => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
      this.resumeAudioContext();
      const files = Array.from(e.dataTransfer.files);
      if (files.length) await this.addFiles(files);
    });

    audioInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files);
      e.target.value = '';
      if (files.length) await this.addFiles(files);
    });

    replaceInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      const itemId = this.replacingItemId;
      e.target.value = '';
      this.replacingItemId = null;
      if (file && itemId) await this.replaceFile(itemId, file);
    });

    // 清单操作（事件委托）
    document.getElementById('clearQueueBtn')
      .addEventListener('click', () => this.clearQueue());
    document.getElementById('downloadQueueBtn')
      .addEventListener('click', () => this.downloadQueue());

    const fileQueue = document.getElementById('fileQueue');
    fileQueue.addEventListener('click', (e) => this.handleQueueClick(e));

    // 区间选择
    const startTime = document.getElementById('startTime');
    const endTime = document.getElementById('endTime');
    startTime.addEventListener('input', () => this.updateRangeSlider());
    endTime.addEventListener('input', () => this.updateRangeSlider());
    this.initRangeSlider();

    // 分析按钮
    document.getElementById('analyzeBtn')
      .addEventListener('click', () => this.analyzeAudio());

    // 记录相关事件
    this.bindRecordEvents();
  }

  resumeAudioContext() {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(() => {});
    }
  }

  // ----------------------------------------------------------------
  // 清单：添加 / 校验 / 解码
  // ----------------------------------------------------------------

  /**
   * 批量添加文件（自动去重，避免重复堆积）
   */
  async addFiles(files) {
    const added = [];
    const skipped = [];
    const invalid = [];

    for (const file of files) {
      if (this.queueManager.hasFile(file)) {
        skipped.push(file.name);
        continue;
      }
      if (this.wasAnalyzed(file)) {
        skipped.push(file.name);
        continue;
      }
      if (!this.isLikelyAudio(file)) {
        invalid.push(`${file.name}：文件格式不支持（非音频文件）`);
        continue;
      }

      const item = await this.queueManager.addFile(file);
      added.push(item);
    }

    this.renderQueue();

    if (added.length === 1 && !this.activeItemId) {
      this.processItem(added[0].id, { activate: true });
    } else {
      added.forEach((item) => this.processItem(item.id));
    }

    // 汇总提示
    if (added.length) {
      this.uiController.showToast(`已添加 ${added.length} 个文件到待分析清单`, 'success');
    }
    if (skipped.length) {
      this.uiController.showToast(
        `跳过 ${skipped.length} 个已在清单或已分析过的文件：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? ' 等' : ''}`,
        'warning'
      );
    }
    if (invalid.length) {
      invalid.slice(0, 3).forEach((reason) =>
        this.uiController.showToast(reason, 'error'));
    }
  }

  /**
   * 根据 MIME / 扩展名判断是否为音频文件
   */
  isLikelyAudio(file) {
    if (file.type && file.type.startsWith('audio/')) return true;
    // blob 拖拽等场景 type 可能为空，用扩展名兜底
    const ext = file.name.includes('.')
      ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()
      : '';
    return AUDIO_EXTENSIONS.has(ext);
  }

  /**
   * 该文件是否已经分析过（与历史记录比对）
   */
  wasAnalyzed(file) {
    return this.recordManager.getAllRecords().some((record) => {
      if (record.fileName !== file.name) return false;
      // 旧记录没有文件大小信息，仅按文件名判定
      if (record.fileSize == null) return true;
      return record.fileSize === file.size;
    });
  }

  /**
   * 读取并解码清单条目
   * @param {string} itemId
   * @param {{activate?: boolean, force?: boolean}} options
   *        force 为 true 时即使是"不支持格式"也尝试重新解码（重试场景）
   */
  async processItem(itemId, options = {}) {
    const item = this.queueManager.getItem(itemId);
    if (!item) return;

    const { activate = false, force = false } = options;

    if (!this.isLikelyAudio({ name: item.name, type: item.type }) && !force) {
      this.queueManager.update(itemId, {
        status: 'error',
        errorReason: '文件格式不支持（非音频文件）'
      });
      this.renderQueue();
      return;
    }

    this.queueManager.update(itemId, {
      status: 'reading',
      errorReason: ''
    });
    this.renderQueue();

    try {
      const blob = item.blob || (await this.queueManager.getBlob(itemId));
      if (!blob) throw new Error('文件数据丢失，无法读取');

      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer.slice(0));

      this.queueManager.update(itemId, {
        status: 'ready',
        duration: audioBuffer.duration,
        errorReason: ''
      });
      this.renderQueue();

      if (activate || (!this.activeItemId && this.getActiveItem() == null)) {
        this.activateItem(itemId);
      }
    } catch (error) {
      const reason = this.describeDecodeError(error, item.name);
      logger.warn('音频读取失败', { name: item.name, reason });
      this.queueManager.update(itemId, {
        status: 'error',
        errorReason: reason
      });
      this.renderQueue();
    }
  }

  /**
   * 给出逐条可读的失败原因
   */
  describeDecodeError(error, fileName) {
    const message = (error && error.message) || '';
    if (/encodingError|Unable to decode|解码/i.test(message)) {
      return '文件已损坏或编码格式不受浏览器支持，读取失败';
    }
    if (fileName && !this.isLikelyAudio({ name: fileName, type: '' })) {
      return '文件格式不支持（非音频文件）';
    }
    return '音频读取失败，请确认文件未损坏后重试';
  }

  // ----------------------------------------------------------------
  // 清单：渲染与交互
  // ----------------------------------------------------------------

  renderQueue() {
    const items = this.queueManager.getItems();
    const listEl = document.getElementById('fileQueue');
    const emptyEl = document.getElementById('queueEmpty');
    const clearBtn = document.getElementById('clearQueueBtn');
    const downloadBtn = document.getElementById('downloadQueueBtn');

    const readyCount = items.filter((i) => i.status === 'ready').length;
    const analyzedCount = items.filter((i) => i.analyzedAt).length;
    const errorCount = items.filter((i) => i.status === 'error').length;

    document.getElementById('queueSummary').innerHTML = items.length
      ? `共 <strong>${items.length}</strong> 项` +
        (readyCount ? ` · 可分析 <strong>${readyCount}</strong>` : '') +
        (analyzedCount ? ` · 已分析 <strong>${analyzedCount}</strong>` : '') +
        (errorCount ? ` · <strong class="queue-summary-error">失败 ${errorCount}</strong>` : '')
      : '';

    clearBtn.disabled = items.length === 0;
    downloadBtn.disabled = items.length === 0;

    if (items.length === 0) {
      listEl.style.display = 'none';
      listEl.innerHTML = '';
      emptyEl.style.display = 'flex';
      this.updateAnalyzeButton();
      return;
    }

    emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    listEl.innerHTML = items.map((item) => this.renderQueueItem(item)).join('');
    this.updateAnalyzeButton();
  }

  renderQueueItem(item) {
    const isActive = item.id === this.activeItemId;
    const formatTag = this.escapeHtml((item.ext || '未知').toUpperCase());

    const actionButtons = `
      <button class="item-btn item-replace" data-action="replace" title="替换此文件">⇄ 替换</button>
      <button class="item-btn item-remove" data-action="remove" title="移除此文件">✕</button>
    `;

    if (item.status === 'reading') {
      return `
        <li class="queue-item reading${isActive ? ' active' : ''}" data-id="${item.id}">
          <div class="item-top">
            <span class="item-icon">⏳</span>
            <span class="item-name">${this.escapeHtml(item.name)}</span>
            <div class="item-actions">
              <button class="item-btn item-remove" data-action="remove" title="移除此文件">✕</button>
            </div>
          </div>
          <div class="item-meta">
            <span class="item-reading-text">正在读取…</span>
          </div>
        </li>
      `;
    }

    if (item.status === 'error') {
      return `
        <li class="queue-item error${isActive ? ' active' : ''}" data-id="${item.id}">
          <div class="item-top">
            <span class="item-icon">⚠️</span>
            <span class="item-name">${this.escapeHtml(item.name)}</span>
            <div class="item-actions">
              <button class="item-btn item-retry" data-action="retry" title="重新读取">↻ 重试</button>
              <button class="item-btn item-remove" data-action="remove" title="移除此文件">✕</button>
            </div>
          </div>
          <div class="item-meta item-error-reason" title="${this.escapeHtml(item.errorReason)}">
            ${this.escapeHtml(item.errorReason || '读取失败')}
          </div>
        </li>
      `;
    }

    return `
      <li class="queue-item ready${isActive ? ' active' : ''}" data-id="${item.id}">
        <div class="item-top">
          <span class="item-icon">🎵</span>
          <span class="item-name">${this.escapeHtml(item.name)}</span>
          <div class="item-actions">${actionButtons}</div>
        </div>
        <div class="item-meta">
          <span class="item-tag item-format">${formatTag}</span>
          <span class="item-tag item-duration">⏱ ${this.formatDuration(item.duration)}</span>
          <span class="item-tag item-size">${this.formatSize(item.size)}</span>
          ${item.analyzedAt ? '<span class="item-tag item-analyzed">✓ 已分析</span>' : ''}
        </div>
      </li>
    `;
  }

  async handleQueueClick(event) {
    const actionEl = event.target.closest('[data-action]');
    const row = event.target.closest('.queue-item');
    if (!row) return;
    const itemId = row.dataset.id;
    const item = this.queueManager.getItem(itemId);
    if (!item) return;

    if (actionEl) {
      event.stopPropagation();
      const action = actionEl.dataset.action;
      if (action === 'remove') {
        await this.removeItem(itemId);
      } else if (action === 'replace') {
        this.replacingItemId = itemId;
        this.resumeAudioContext();
        document.getElementById('replaceInput').click();
      } else if (action === 'retry') {
        await this.processItem(itemId, { force: true, activate: item.status === 'error' && itemId === this.activeItemId });
      }
      return;
    }

    // 点击条目主体：设为当前分析文件
    if (item.status === 'ready') {
      this.activateItem(itemId);
    } else if (item.status === 'error') {
      this.uiController.showToast(`${item.name}：${item.errorReason}`, 'warning');
    }
  }

  async removeItem(itemId) {
    await this.queueManager.remove(itemId);
    if (this.activeItemId === itemId) {
      this.activeItemId = null;
      this.resetWorkspace();
    }
    this.renderQueue();
    // 自动选中下一个可分析文件
    if (!this.activeItemId) {
      const next = this.queueManager.getItems().find((i) => i.status === 'ready');
      if (next) this.activateItem(next.id);
    }
    this.uiController.showToast('文件已从清单移除', 'info');
  }

  async replaceFile(itemId, file) {
    // 去重（排除自身）
    const duplicate = this.queueManager.getItems().some(
      (i) => i.id !== itemId && i.name === file.name && i.size === file.size
    );
    if (duplicate || this.wasAnalyzed(file)) {
      this.uiController.showToast('该文件已在清单中或已分析过，无需重复添加', 'warning');
      return;
    }
    if (!this.isLikelyAudio(file)) {
      this.uiController.showToast(`${file.name}：文件格式不支持（非音频文件）`, 'error');
      return;
    }

    await this.queueManager.replaceFile(itemId, file);
    this.renderQueue();
    await this.processItem(itemId, { force: true, activate: itemId === this.activeItemId });
  }

  async clearQueue() {
    if (this.queueManager.getItems().length === 0) return;
    if (!confirm('确定清空整份待分析清单吗？此操作不可恢复。')) return;
    await this.queueManager.clear();
    this.activeItemId = null;
    this.resetWorkspace();
    this.renderQueue();
    this.uiController.showToast('清单已清空', 'info');
  }

  /**
   * 将整份清单（音频文件 + manifest）打包为 ZIP 下载留档
   */
  async downloadQueue() {
    const items = this.queueManager.getItems();
    if (items.length === 0) return;

    try {
      this.uiController.showLoading('正在打包清单…');
      const entries = await this.queueManager.getEntriesWithBlobs();

      if (entries.length === 0) {
        this.uiController.showToast('没有可下载的文件数据', 'error');
        return;
      }

      const manifest = {
        exportedAt: new Date().toISOString(),
        totalFiles: entries.length,
        files: items.map((item) => ({
          name: item.name,
          format: (item.ext || '').toUpperCase() || '未知',
          sizeBytes: item.size,
          durationSeconds: item.duration,
          status: item.status === 'ready'
            ? 'ready'
            : item.status === 'error'
              ? `error: ${item.errorReason}`
              : 'reading',
          analyzed: !!item.analyzedAt
        }))
      };
      const manifestBlob = new Blob([JSON.stringify(manifest, null, 2)], {
        type: 'application/json'
      });

      const zipEntries = reserveZipNames(entries, ['manifest.json']);
      zipEntries.unshift({ name: 'manifest.json', zipName: 'manifest.json', blob: manifestBlob });

      const zipBlob = await createZip(zipEntries);
      const stamp = this.recordManager.formatTimestamp().replace(/[: ]/g, '-');
      downloadBlob(zipBlob, `待分析清单-${stamp}.zip`);
      this.uiController.showToast(`已打包 ${entries.length} 个文件`, 'success');
    } catch (error) {
      logger.error('打包下载失败', error);
      this.uiController.showToast('打包下载失败：' + error.message, 'error');
    } finally {
      this.uiController.hideLoading();
    }
  }

  // ----------------------------------------------------------------
  // 当前活动文件与工作区
  // ----------------------------------------------------------------

  getActiveItem() {
    return this.activeItemId
      ? this.queueManager.getItem(this.activeItemId)
      : null;
  }

  async activateItem(itemId) {
    const item = this.queueManager.getItem(itemId);
    if (!item || item.status !== 'ready') return;

    try {
      const blob = item.blob || (await this.queueManager.getBlob(itemId));
      if (!blob) throw new Error('文件数据丢失');

      this.activeItemId = itemId;
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer.slice(0));

      this.loadAudioBuffer(item, audioBuffer, blob);
      this.renderQueue();
    } catch (error) {
      logger.error('载入文件失败', error);
      this.uiController.showToast(`${item.name} 载入失败`, 'error');
    }
  }

  /**
   * 将解码后的音频载入播放、区间与分析工作区
   */
  loadAudioBuffer(item, audioBuffer, blob) {
    const durationMs = Math.floor(audioBuffer.duration * 1000);

    // 播放器
    const audioPlayer = document.getElementById('audioPlayer');
    if (audioPlayer.src) URL.revokeObjectURL(audioPlayer.src);
    audioPlayer.src = URL.createObjectURL(blob);
    document.getElementById('audioPlayerSection').style.display = 'block';
    document.getElementById('totalDuration').textContent = audioBuffer.duration.toFixed(3);

    // 区间选择
    document.getElementById('startTime').value = 0;
    document.getElementById('startTime').max = durationMs;
    document.getElementById('endTime').value = durationMs;
    document.getElementById('endTime').max = durationMs;
    this.updateRangeSlider();

    // 重置上一文件的分析结果
    this.audioBuffer = audioBuffer;
    this.currentAnalysisResult = null;
    document.getElementById('chartContainer').style.display = 'none';
    document.getElementById('emptyState').style.display = 'flex';
    document.getElementById('fundamentalInfo').style.display = 'none';
    document.getElementById('saveRecordSection').style.display = 'none';
    this.chartManager.clearAllCharts();

    this.updateAnalyzeButton();
  }

  resetWorkspace() {
    this.audioBuffer = null;
    this.currentAnalysisResult = null;

    const audioPlayer = document.getElementById('audioPlayer');
    if (audioPlayer.src) {
      URL.revokeObjectURL(audioPlayer.src);
      audioPlayer.removeAttribute('src');
      audioPlayer.load();
    }
    document.getElementById('audioPlayerSection').style.display = 'none';
    document.getElementById('chartContainer').style.display = 'none';
    document.getElementById('emptyState').style.display = 'flex';
    document.getElementById('fundamentalInfo').style.display = 'none';
    document.getElementById('saveRecordSection').style.display = 'none';

    document.getElementById('startTime').value = 0;
    document.getElementById('endTime').value = 0;
    this.updateAnalyzeButton();
    this.chartManager.clearAllCharts();
  }

  updateAnalyzeButton() {
    const item = this.getActiveItem();
    document.getElementById('analyzeBtn').disabled = !(item && item.status === 'ready');
  }

  /**
   * 页面重新打开后恢复清单：读取文件状态并载入首个可分析文件
   */
  async restoreQueue() {
    const items = this.queueManager.getItems();
    let firstReady = null;

    for (const item of items) {
      if (item.status === 'ready' || item.status === 'reading' || item.status === 'error') {
        if (!firstReady && item.status === 'ready') firstReady = item;
        // ready/reading 的文件重新验证解码（持久化的时长信息仅作展示缓存）
        if (item.status !== 'error') {
          await this.processItem(item.id);
          const refreshed = this.queueManager.getItem(item.id);
          if (!firstReady && refreshed && refreshed.status === 'ready') {
            firstReady = refreshed;
          }
        }
      }
    }

    if (firstReady) {
      await this.activateItem(firstReady.id);
    } else {
      this.updateAnalyzeButton();
    }
  }

  // ----------------------------------------------------------------
  // 区间选择滑块
  // ----------------------------------------------------------------

  initRangeSlider() {
    const track = document.getElementById('rangeTrack');
    const handleStart = document.getElementById('handleStart');
    const handleEnd = document.getElementById('handleEnd');
    let isDragging = null;

    const updateFromSlider = (clientX) => {
      const rect = track.getBoundingClientRect();
      const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const maxMs = parseInt(document.getElementById('endTime').max) || 1000;
      const value = Math.round(percent * maxMs);

      if (isDragging === 'start') {
        const endValue = parseInt(document.getElementById('endTime').value);
        if (value < endValue) {
          document.getElementById('startTime').value = value;
        }
      } else if (isDragging === 'end') {
        const startValue = parseInt(document.getElementById('startTime').value);
        if (value > startValue) {
          document.getElementById('endTime').value = value;
        }
      }

      this.updateRangeSlider();
    };

    handleStart.addEventListener('mousedown', () => isDragging = 'start');
    handleEnd.addEventListener('mousedown', () => isDragging = 'end');

    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        updateFromSlider(e.clientX);
      }
    });

    document.addEventListener('mouseup', () => {
      isDragging = null;
    });
  }

  updateRangeSlider() {
    let startTime = parseInt(document.getElementById('startTime').value) || 0;
    let endTime = parseInt(document.getElementById('endTime').value) || 0;
    const maxTime = parseInt(document.getElementById('endTime').max) || 1000;

    // 确保起始时间不大于结束时间
    if (startTime > endTime) {
      const temp = startTime;
      startTime = endTime;
      endTime = temp;
      document.getElementById('startTime').value = startTime;
      document.getElementById('endTime').value = endTime;
    }

    startTime = Math.max(0, Math.min(startTime, maxTime));
    endTime = Math.max(0, Math.min(endTime, maxTime));

    const startPercent = (startTime / maxTime) * 100;
    const endPercent = (endTime / maxTime) * 100;

    document.getElementById('handleStart').style.left = `${startPercent}%`;
    document.getElementById('handleEnd').style.left = `${endPercent}%`;
    document.getElementById('rangeSelected').style.left = `${startPercent}%`;
    document.getElementById('rangeSelected').style.width = `${Math.max(0, endPercent - startPercent)}%`;

    const durationSec = Math.max(0, endTime - startTime) / 1000;
    document.getElementById('selectedDuration').textContent = durationSec.toFixed(3);
  }

  // ----------------------------------------------------------------
  // 分析
  // ----------------------------------------------------------------

  async analyzeAudio() {
    const item = this.getActiveItem();
    if (!item || item.status !== 'ready' || !this.audioBuffer) {
      this.uiController.showToast('请先从清单中选择一个可分析的音频文件', 'warning');
      return;
    }

    const startMs = parseInt(document.getElementById('startTime').value) || 0;
    const endMs = parseInt(document.getElementById('endTime').value) || 0;

    if (startMs >= endMs) {
      alert('请选择有效的时间区间');
      return;
    }

    logger.info('开始分析音频', { file: item.name, startMs, endMs });

    try {
      this.uiController.showLoading('正在分析音频...');
      const fftSize = parseInt(document.getElementById('fftSize').value);

      const startSample = Math.floor((startMs / 1000) * this.audioBuffer.sampleRate);
      const endSample = Math.floor((endMs / 1000) * this.audioBuffer.sampleRate);
      const channelData = this.audioBuffer.getChannelData(0);
      const selectedData = channelData.slice(startSample, endSample);

      const analysisResult = await this.audioAnalyzer.analyze(
        selectedData, this.audioBuffer.sampleRate, fftSize
      );

      logger.info('音频分析完成', {
        file: item.name,
        fundamentalFreq: analysisResult.fundamentalFreq,
        harmonicsCount: analysisResult.harmonics.length
      });

      this.currentAnalysisResult = analysisResult;

      this.chartManager.updateAllCharts(analysisResult, selectedData, this.audioBuffer.sampleRate);
      this.updateFundamentalInfo(analysisResult);

      document.getElementById('chartContainer').style.display = 'flex';
      document.getElementById('emptyState').style.display = 'none';
      document.getElementById('saveRecordSection').style.display = 'block';
      document.getElementById('recordName').value = `${item.name} - ${this.recordManager.formatTimestamp()}`;
      document.getElementById('recordNote').value = '';

      // 标记该文件已分析（用于去重与清单徽标）
      this.queueManager.update(item.id, { analyzedAt: Date.now() });
      this.renderQueue();
    } catch (error) {
      logger.error('音频分析失败', error);
      this.uiController.showToast('音频分析失败: ' + error.message, 'error');
    } finally {
      this.uiController.hideLoading();
    }
  }

  updateFundamentalInfo(result) {
    document.getElementById('fundamentalInfo').style.display = 'block';
    document.getElementById('fundamentalFreq').textContent = result.fundamentalFreq.toFixed(2);

    const harmonicsList = document.getElementById('harmonicsList');
    harmonicsList.innerHTML = result.harmonics.map((h, i) => `
      <div class="harmonic-item">
        <span class="harmonic-label">${i + 2}倍频</span>
        <span class="harmonic-freq">${h.toFixed(1)} Hz</span>
      </div>
    `).join('');
  }

  // ----------------------------------------------------------------
  // 历史记录
  // ----------------------------------------------------------------

  bindRecordEvents() {
    document.getElementById('saveRecordBtn').addEventListener('click', () => this.saveRecord());
    document.getElementById('toggleRecordsBtn').addEventListener('click', () => this.toggleRecordsPanel());
    document.getElementById('closeModalBtn').addEventListener('click', () => this.closeRecordModal());
    document.getElementById('recordDetailModal').addEventListener('click', (e) => {
      if (e.target.id === 'recordDetailModal') {
        this.closeRecordModal();
      }
    });
    document.getElementById('applyRecordBtn').addEventListener('click', () => this.applyRecord());
    document.getElementById('deleteRecordBtn').addEventListener('click', () => this.deleteRecord());
  }

  saveRecord() {
    if (!this.currentAnalysisResult) {
      this.uiController.showToast('没有可保存的分析结果', 'warning');
      return;
    }

    const item = this.getActiveItem();
    const name = document.getElementById('recordName').value.trim();
    const note = document.getElementById('recordNote').value.trim();
    const startMs = parseInt(document.getElementById('startTime').value) || 0;
    const endMs = parseInt(document.getElementById('endTime').value) || 0;

    const harmonicIntensities = this.extractHarmonicIntensities(this.currentAnalysisResult);

    try {
      const record = this.recordManager.createRecord({
        fileName: item ? item.name : '未知文件',
        fileSize: item ? item.size : null,
        startMs,
        endMs,
        fundamentalFreq: this.currentAnalysisResult.fundamentalFreq,
        harmonics: this.currentAnalysisResult.harmonics,
        harmonicIntensities,
        analysisResult: this.currentAnalysisResult,
        name
      });

      if (note) {
        this.recordManager.updateRecord(record.id, { note });
      }

      this.uiController.showToast('记录保存成功', 'success');
      this.updateRecordsList();
    } catch (error) {
      this.uiController.showToast(error.message, 'error');
    }
  }

  extractHarmonicIntensities(analysisResult) {
    const { fundamentalFreq, harmonics, frequencies, magnitudes } = analysisResult;
    const allHarmonics = [fundamentalFreq, ...harmonics];
    const intensities = {};

    allHarmonics.forEach((harmonic, index) => {
      let closestMag = 0;
      let minDist = Infinity;

      for (let i = 0; i < frequencies.length; i++) {
        const dist = Math.abs(frequencies[i] - harmonic);
        if (dist < minDist) {
          minDist = dist;
          closestMag = magnitudes[i];
        }
      }

      const key = index === 0 ? 'fundamental' : `harmonic${index + 1}`;
      intensities[key] = closestMag;
    });

    const maxMag = Math.max(...Object.values(intensities));
    const normalizedIntensities = {};
    Object.keys(intensities).forEach((key) => {
      normalizedIntensities[key] = maxMag > 0 ? (intensities[key] / maxMag) * 100 : 0;
    });

    return normalizedIntensities;
  }

  updateRecordsList() {
    const records = this.recordManager.getAllRecords();
    const recordsList = document.getElementById('recordsList');
    const recordsEmpty = document.getElementById('recordsEmpty');

    if (records.length === 0) {
      recordsList.style.display = 'none';
      recordsEmpty.style.display = 'flex';
      return;
    }

    recordsList.style.display = 'block';
    recordsEmpty.style.display = 'none';

    recordsList.innerHTML = records.map((record) => `
      <div class="record-item" data-id="${record.id}">
        <div class="record-main">
          <span class="record-name" title="${this.escapeHtml(record.name)}">${this.escapeHtml(this.truncateText(record.name, 25))}</span>
          <span class="record-freq">${record.fundamentalFreq.toFixed(1)} Hz</span>
        </div>
        <div class="record-meta">
          <span class="record-file" title="${this.escapeHtml(record.fileName)}">${this.escapeHtml(this.truncateText(record.fileName, 20))}</span>
          <span class="record-time">${this.recordManager.formatDate(record.createdAt)}</span>
        </div>
      </div>
    `).join('');

    recordsList.querySelectorAll('.record-item').forEach((itemEl) => {
      itemEl.addEventListener('click', () => {
        this.showRecordDetail(itemEl.dataset.id);
      });
    });
  }

  truncateText(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }

  toggleRecordsPanel() {
    const content = document.getElementById('recordsContent');
    const btn = document.getElementById('toggleRecordsBtn');

    if (content.style.display === 'none') {
      content.style.display = 'block';
      btn.textContent = '▼';
    } else {
      content.style.display = 'none';
      btn.textContent = '▶';
    }
  }

  showRecordDetail(recordId) {
    const record = this.recordManager.getRecord(recordId);
    if (!record) return;

    this.selectedRecordId = recordId;

    const modalBody = document.getElementById('modalBody');
    document.getElementById('modalTitle').textContent = record.name;

    modalBody.innerHTML = `
      <div class="record-detail">
        <div class="detail-section">
          <h4>基本信息</h4>
          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-label">文件名</span>
              <span class="detail-value">${this.escapeHtml(record.fileName)}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">创建时间</span>
              <span class="detail-value">${this.recordManager.formatTimestampFull(record.createdAt)}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">分析区间</span>
              <span class="detail-value">${record.startMs}ms - ${record.endMs}ms (${(record.durationMs / 1000).toFixed(3)}s)</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">基频</span>
              <span class="detail-value highlight">${record.fundamentalFreq.toFixed(2)} Hz</span>
            </div>
          </div>
        </div>

        <div class="detail-section">
          <h4>倍频与强度</h4>
          <div class="harmonics-table">
            <div class="table-header">
              <span>谐波</span>
              <span>频率</span>
              <span>相对强度</span>
            </div>
            <div class="table-row">
              <span>基频</span>
              <span>${record.fundamentalFreq.toFixed(1)} Hz</span>
              <span>
                <div class="intensity-bar">
                  <div class="intensity-fill" style="width: ${record.harmonicIntensities?.fundamental || 100}%"></div>
                  <span class="intensity-text">${(record.harmonicIntensities?.fundamental || 100).toFixed(1)}%</span>
                </div>
              </span>
            </div>
            ${record.harmonics.map((h, i) => {
              const intensityKey = `harmonic${i + 2}`;
              const intensity = record.harmonicIntensities?.[intensityKey] || 0;
              return `
                <div class="table-row">
                  <span>${i + 2}倍频</span>
                  <span>${h.toFixed(1)} Hz</span>
                  <span>
                    <div class="intensity-bar">
                      <div class="intensity-fill" style="width: ${intensity}%"></div>
                      <span class="intensity-text">${intensity.toFixed(1)}%</span>
                    </div>
                  </span>
                </div>
              `;
            }).join('')}
          </div>
        </div>

        ${record.note ? `
          <div class="detail-section">
            <h4>备注</h4>
            <p class="record-note">${this.escapeHtml(record.note)}</p>
          </div>
        ` : ''}
      </div>
    `;

    document.getElementById('recordDetailModal').style.display = 'flex';
  }

  closeRecordModal() {
    document.getElementById('recordDetailModal').style.display = 'none';
    this.selectedRecordId = null;
  }

  applyRecord() {
    if (!this.selectedRecordId) return;

    const record = this.recordManager.getRecord(this.selectedRecordId);
    if (!record) return;

    if (!record.analysisResult) {
      this.uiController.showToast('该记录不包含完整的分析数据', 'warning');
      return;
    }

    this.currentAnalysisResult = record.analysisResult;

    const fakeAudioData = new Float32Array(1000).fill(0);
    const sampleRate = 44100;
    this.chartManager.updateAllCharts(record.analysisResult, fakeAudioData, sampleRate);
    this.updateFundamentalInfo(record.analysisResult);

    document.getElementById('chartContainer').style.display = 'flex';
    document.getElementById('emptyState').style.display = 'none';

    this.closeRecordModal();
    this.uiController.showToast('记录已应用', 'success');
  }

  deleteRecord() {
    if (!this.selectedRecordId) return;

    if (confirm('确定要删除这条记录吗？此操作不可恢复。')) {
      const success = this.recordManager.deleteRecord(this.selectedRecordId);
      if (success) {
        this.updateRecordsList();
        this.closeRecordModal();
        this.uiController.showToast('记录已删除', 'success');
      } else {
        this.uiController.showToast('删除失败', 'error');
      }
    }
  }

  // ----------------------------------------------------------------
  // 格式化工具
  // ----------------------------------------------------------------

  escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 时长格式化：短于 1 分钟显示 x.xxx 秒，否则 m:ss.xxx
   */
  formatDuration(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return '--';
    if (seconds < 60) return `${seconds.toFixed(3)} 秒`;
    const mins = Math.floor(seconds / 60);
    const rest = seconds - mins * 60;
    return `${mins}:${rest.toFixed(3).padStart(6, '0')}`;
  }

  formatSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
}

// 启动应用
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});
