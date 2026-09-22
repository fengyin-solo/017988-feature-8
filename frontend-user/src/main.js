import { AudioAnalyzer } from './modules/audioAnalyzer.js';
import { ChartManager } from './modules/chartManager.js';
import { UIController } from './modules/uiController.js';
import { RecordManager } from './modules/recordManager.js';
import { FileQueueStore } from './modules/fileQueueStore.js';
import { buildZip } from './utils/zip.js';
import { Logger } from './utils/logger.js';

// 初始化日志
const logger = new Logger('Main');

// 应用初始化
class App {
  constructor() {
    this.audioAnalyzer = null;
    this.chartManager = null;
    this.uiController = null;
    this.recordManager = null;
    this.fileQueue = new FileQueueStore();
    this.audioBuffer = null;
    this.audioContext = null;
    this.currentAnalysisResult = null;
    this.currentFileName = '';
    this.selectedItemId = null;
    this.loadedItemId = null;
    this.loadToken = null;
    this.playerObjectUrl = null;
    this.selectedRecordId = null;
    this.dragCounter = 0;
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

      // 加载持久化的待分析清单（IndexedDB）
      await this.fileQueue.init();

      // 绑定事件
      this.bindEvents();

      // 依据已保存的历史记录，恢复清单中"已分析"标记
      this.reconcileAnalyzedFlags();

      // 渲染清单与历史记录
      this.renderQueue();
      this.updateRecordsList();

      logger.info('应用初始化完成');
    } catch (error) {
      logger.error('应用初始化失败', error);
      alert('应用初始化失败，请刷新页面重试');
    }
  }

  /** 解码 ArrayBuffer，供清单校验 / 加载复用 */
  decodeAudio(arrayBuffer) {
    return this.audioContext.decodeAudioData(arrayBuffer);
  }

  bindEvents() {
    // 文件上传（批量）
    const uploadArea = document.getElementById('uploadArea');
    const audioInput = document.getElementById('audioInput');
    const replaceInput = document.getElementById('replaceInput');

    uploadArea.addEventListener('click', () => audioInput.click());

    // 拖入时阻止浏览器默认打开文件，并在整个窗口上做兜底
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    uploadArea.addEventListener('dragenter', (e) => {
      e.preventDefault();
      this.dragCounter++;
      uploadArea.classList.add('dragover');
    });
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('dragover');
    });
    uploadArea.addEventListener('dragleave', () => {
      this.dragCounter = Math.max(0, this.dragCounter - 1);
      if (this.dragCounter === 0) uploadArea.classList.remove('dragover');
    });
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dragCounter = 0;
      uploadArea.classList.remove('dragover');
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length > 0) this.handleFiles(files);
    });

    audioInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) this.handleFiles(files);
      e.target.value = '';
    });

    replaceInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      const replaceId = e.target.dataset.id;
      e.target.value = '';
      delete e.target.dataset.id;
      if (file && replaceId) {
        this.fileQueue.replaceItem(replaceId, file, {
          decode: (buf) => this.decodeAudio(buf),
          isAnalyzed: (f) => this.isPreviouslyAnalyzed(f)
        }).then(() => {
          // 替换的是当前已加载文件时，丢弃旧的播放 / 分析状态
          if (replaceId === this.selectedItemId && this.loadedItemId === replaceId) {
            this.loadedItemId = null;
            this.resetAnalysisPanels();
            this.renderQueue();
          }
        });
      }
    });

    // 清单工具栏
    document.getElementById('clearQueueBtn').addEventListener('click', () => this.clearQueue());
    document.getElementById('downloadZipBtn').addEventListener('click', () => this.downloadQueueZip());

    // 清单数据变化
    this.fileQueue.addEventListener('change', () => this.renderQueue());
    this.fileQueue.addEventListener('duplicates', (e) => {
      const names = e.detail.names;
      this.uiController.showToast(`已跳过 ${names.length} 个清单中已存在的文件`, 'warning');
    });

    // 区间选择
    const startTime = document.getElementById('startTime');
    const endTime = document.getElementById('endTime');
    startTime.addEventListener('input', () => this.updateRangeSlider());
    endTime.addEventListener('input', () => this.updateRangeSlider());

    // 范围滑块拖拽
    this.initRangeSlider();

    // 分析按钮
    const analyzeBtn = document.getElementById('analyzeBtn');
    analyzeBtn.addEventListener('click', () => this.analyzeAudio());

    // 记录相关事件
    this.bindRecordEvents();
  }

  /**
   * 批量接收文件（选择或拖入）
   */
  async handleFiles(files) {
    const { added, duplicates } = await this.fileQueue.addFiles(files, {
      decode: (buf) => this.decodeAudio(buf),
      isAnalyzed: (f) => this.isPreviouslyAnalyzed(f)
    });

    if (added.length > 0) {
      this.uiController.showToast(
        `已添加 ${added.length} 个文件到待分析清单`,
        'success'
      );
    } else if (duplicates.length > 0) {
      // 全部重复时 change 事件不一定触发，toast 由 duplicates 事件处理
      logger.info('本批文件均已在清单中', { duplicates });
    }
  }

  /**
   * 判断文件是否已经分析过（命中已保存的历史记录文件名）
   * 已经分析过的文件再次上传不重复堆积，仅在清单中标记"已分析"
   */
  isPreviouslyAnalyzed(file) {
    return this.recordManager.getAllRecords().some(r => r.fileName === file.name);
  }

  /**
   * 启动时用历史记录校准清单的"已分析"标记
   */
  reconcileAnalyzedFlags() {
    const analyzedNames = new Set(
      this.recordManager.getAllRecords().map(r => r.fileName)
    );
    for (const item of this.fileQueue.getItems()) {
      const should = analyzedNames.has(item.name);
      if (item.analyzed !== should) {
        this.fileQueue.markAnalyzed(item.id, should);
      }
    }
  }

  /**
   * 渲染待分析清单
   */
  renderQueue() {
    const items = this.fileQueue.getItems();
    const listEl = document.getElementById('uploadList');
    const emptyEl = document.getElementById('queueEmpty');
    const toolbarEl = document.getElementById('queueToolbar');
    const countEl = document.getElementById('queueCount');
    const analyzeBtn = document.getElementById('analyzeBtn');

    // 空态
    const isEmpty = items.length === 0;
    emptyEl.style.display = isEmpty ? 'flex' : 'none';
    listEl.style.display = isEmpty ? 'none' : 'flex';
    toolbarEl.style.display = isEmpty ? 'none' : 'flex';

    if (!isEmpty) {
      const readyCount = items.filter(i => i.status === 'ready').length;
      const errorCount = items.filter(i => i.status === 'error').length;
      countEl.textContent = `待分析 ${items.length} 项 · ${readyCount} 项就绪` +
        (errorCount > 0 ? ` · ${errorCount} 项异常` : '');
    }

    // 选中项已被移除 -> 重置播放 / 分析面板
    if (this.selectedItemId && !this.fileQueue.getItem(this.selectedItemId)) {
      this.selectedItemId = null;
      this.loadedItemId = null;
      this.loadToken = null;
      this.resetAnalysisPanels();
    }

    // 选中项变为异常状态 -> 收起基于旧文件的播放 / 分析面板
    const selectedNow = this.selectedItemId ? this.fileQueue.getItem(this.selectedItemId) : null;
    if (selectedNow && selectedNow.status === 'error' && this.loadedItemId === selectedNow.id) {
      this.loadedItemId = null;
      this.loadToken = null;
      this.resetAnalysisPanels();
    }

    // 无选中项时自动选中第一个就绪文件
    if (!this.selectedItemId) {
      const firstReady = items.find(i => i.status === 'ready');
      if (firstReady) {
        this.selectedItemId = firstReady.id;
        this.loadedItemId = null;
      }
    }

    listEl.innerHTML = items.map(item => this.renderQueueItem(item)).join('');

    listEl.querySelectorAll('.queue-item').forEach(row => {
      const id = row.dataset.id;

      row.querySelector('.queue-item-main')?.addEventListener('click', () => {
        const item = this.fileQueue.getItem(id);
        if (item && item.status !== 'error') this.selectItem(id);
      });

      row.querySelector('.btn-item-remove')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.fileQueue.removeItem(id);
      });

      row.querySelector('.btn-item-replace')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const replaceInput = document.getElementById('replaceInput');
        replaceInput.dataset.id = id;
        replaceInput.click();
      });

      row.querySelector('.btn-item-retry')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.fileQueue.retryItem(id, (buf) => this.decodeAudio(buf));
      });
    });

    const selected = this.selectedItemId
      ? this.fileQueue.getItem(this.selectedItemId)
      : null;
    analyzeBtn.disabled = !(selected && selected.status === 'ready');

    // 选中项就绪但播放器尚未加载 -> 加载
    if (selected && selected.status === 'ready' && this.loadedItemId !== selected.id) {
      this.loadSelectedItem();
    }
  }

  renderQueueItem(item) {
    const isSelected = item.id === this.selectedItemId;
    const classes = ['queue-item', `status-${item.status}`];
    if (isSelected) classes.push('selected');

    let metaHtml;
    if (item.status === 'reading') {
      metaHtml = `
        <span class="queue-item-format">${this.escapeHtml(item.format)}</span>
        <span class="queue-item-duration queue-item-reading">读取中…</span>
        <span class="queue-item-size">${this.formatSize(item.size)}</span>`;
    } else if (item.status === 'error') {
      metaHtml = `
        <span class="queue-item-format">${this.escapeHtml(item.format)}</span>
        <span class="queue-item-duration">时长 --</span>
        <span class="queue-item-size">${this.formatSize(item.size)}</span>`;
    } else {
      metaHtml = `
        <span class="queue-item-format">${this.escapeHtml(item.format)}</span>
        <span class="queue-item-duration">时长 ${this.formatDuration(item.durationMs)}</span>
        <span class="queue-item-size">${this.formatSize(item.size)}</span>`;
    }

    const analyzedBadge = item.analyzed
      ? '<span class="queue-badge queue-badge-done">已分析</span>'
      : '';

    const errorHtml = item.status === 'error' ? `
      <div class="queue-item-error">
        <span class="queue-error-text" title="${this.escapeHtml(item.errorMessage || '')}">
          ⚠ ${this.escapeHtml(item.errorMessage || '读取失败')}
        </span>
        <button class="btn-item-retry" type="button">重试</button>
      </div>` : '';

    return `
      <li class="${classes.join(' ')}" data-id="${item.id}">
        <div class="queue-item-main">
          <div class="queue-item-title">
            <span class="queue-item-name" title="${this.escapeHtml(item.name)}">${this.escapeHtml(item.name)}</span>
            ${analyzedBadge}
          </div>
          <div class="queue-item-meta">${metaHtml}</div>
          ${errorHtml}
        </div>
        <div class="queue-item-ops">
          <button class="btn-item-icon btn-item-replace" type="button" title="替换此文件">🔄</button>
          <button class="btn-item-icon btn-item-remove" type="button" title="移除此文件">✕</button>
        </div>
      </li>`;
  }

  /**
   * 选中清单中的某个文件
   */
  async selectItem(id) {
    if (id === this.selectedItemId) return;
    this.selectedItemId = id;
    this.loadedItemId = null;
    this.loadToken = null;
    this.resetAnalysisPanels();
    this.renderQueue();
  }

  /**
   * 加载当前选中项到播放器与分析区间
   */
  async loadSelectedItem() {
    const item = this.fileQueue.getItem(this.selectedItemId);
    if (!item || item.status !== 'ready') return;

    // 防止多次渲染并发加载同一项
    const loadToken = Symbol('load');
    this.loadToken = loadToken;

    try {
      const file = await this.fileQueue.getFile(item.id);
      if (this.loadToken !== loadToken || this.selectedItemId !== item.id) return;
      if (!file) {
        await this.fileQueue.markError(item.id, 'read', '文件数据已丢失，请移除后重新添加');
        return;
      }

      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await this.decodeAudio(arrayBuffer);

      if (this.loadToken !== loadToken || this.selectedItemId !== item.id) return;

      this.audioBuffer = audioBuffer;
      this.currentFileName = item.name;
      this.loadedItemId = item.id;

      // 播放器
      if (this.playerObjectUrl) URL.revokeObjectURL(this.playerObjectUrl);
      this.playerObjectUrl = URL.createObjectURL(file);
      const audioPlayer = document.getElementById('audioPlayer');
      audioPlayer.src = this.playerObjectUrl;
      const playerName = document.getElementById('audioPlayerName');
      playerName.textContent = item.name;
      playerName.title = item.name;
      document.getElementById('audioPlayerSection').style.display = 'block';
      document.getElementById('totalDuration').textContent = audioBuffer.duration.toFixed(3);

      // 分析区间默认全选
      const durationMs = Math.floor(audioBuffer.duration * 1000);
      document.getElementById('startTime').value = 0;
      document.getElementById('startTime').max = durationMs;
      document.getElementById('endTime').value = durationMs;
      document.getElementById('endTime').max = durationMs;
      this.updateRangeSlider();

      document.getElementById('analyzeBtn').disabled = false;
      logger.info('已加载清单文件', { name: item.name, duration: audioBuffer.duration });
    } catch (error) {
      logger.error('加载选中文件失败', error);
      this.uiController.showToast(`「${item.name}」加载失败，请重试`, 'error');
      await this.fileQueue.markError(item.id, 'decode', '音频读取失败：文件已损坏或编码格式不受浏览器支持');
    }
  }

  /**
   * 清空清单
   */
  async clearQueue() {
    if (this.fileQueue.getItems().length === 0) return;
    if (!confirm('确定要清空整份待分析清单吗？此操作不可恢复。')) return;
    this.selectedItemId = null;
    this.loadedItemId = null;
    await this.fileQueue.clear();
    this.resetAnalysisPanels();
    this.renderQueue();
  }

  /**
   * 把整份清单（含元数据清单）打包为 zip 下载留档
   */
  async downloadQueueZip() {
    const items = this.fileQueue.getItems();
    if (items.length === 0) {
      this.uiController.showToast('清单为空，没有可打包的文件', 'warning');
      return;
    }

    try {
      this.uiController.showLoading('正在打包清单...');

      // 处理重名文件
      const usedNames = new Set();
      const uniqueName = (name) => {
        if (!usedNames.has(name)) {
          usedNames.add(name);
          return name;
        }
        const dot = name.lastIndexOf('.');
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        let i = 2;
        let candidate;
        do {
          candidate = `${base} (${i++})${ext}`;
        } while (usedNames.has(candidate));
        usedNames.add(candidate);
        return candidate;
      };

      const entries = [];
      const manifestItems = [];

      for (const item of items) {
        const blob = await this.fileQueue.getFile(item.id);
        if (blob) {
          entries.push({
            name: uniqueName(item.name),
            data: blob,
            date: new Date(item.lastModified || item.addedAt)
          });
        }
        manifestItems.push({
          name: item.name,
          format: item.format,
          sizeBytes: item.size,
          durationMs: item.durationMs,
          durationText: item.durationMs != null ? this.formatDuration(item.durationMs) : null,
          status: item.status,
          errorMessage: item.errorMessage,
          analyzed: item.analyzed,
          lastModified: item.lastModified
            ? new Date(item.lastModified).toISOString()
            : null,
          addedAt: new Date(item.addedAt).toISOString()
        });
      }

      const manifest = {
        exportedAt: new Date().toISOString(),
        count: items.length,
        files: manifestItems
      };
      entries.push({
        name: 'manifest.json',
        data: new TextEncoder().encode(JSON.stringify(manifest, null, 2))
      });

      const zipBlob = await buildZip(entries);
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `待分析清单_${this.formatFileTimestamp()}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      this.uiController.showToast(`已打包 ${items.length} 个文件`, 'success');
    } catch (error) {
      logger.error('打包下载失败', error);
      this.uiController.showToast('打包下载失败：' + (error.message || '未知错误'), 'error');
    } finally {
      this.uiController.hideLoading();
    }
  }

  /**
   * 重置播放区与分析结果面板（切换 / 移除文件时）
   */
  resetAnalysisPanels() {
    this.audioBuffer = null;
    this.currentAnalysisResult = null;
    this.currentFileName = '';

    if (this.playerObjectUrl) {
      URL.revokeObjectURL(this.playerObjectUrl);
      this.playerObjectUrl = null;
    }

    const player = document.getElementById('audioPlayer');
    player.pause();
    player.removeAttribute('src');
    player.load();
    document.getElementById('audioPlayerSection').style.display = 'none';

    document.getElementById('analyzeBtn').disabled = true;
    document.getElementById('chartContainer').style.display = 'none';
    document.getElementById('emptyState').style.display = 'flex';
    document.getElementById('fundamentalInfo').style.display = 'none';
    document.getElementById('saveRecordSection').style.display = 'none';

    this.chartManager.clearAllCharts();
  }

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
      // 交换值
      const temp = startTime;
      startTime = endTime;
      endTime = temp;
      document.getElementById('startTime').value = startTime;
      document.getElementById('endTime').value = endTime;
    }

    // 确保值在有效范围内
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

  async analyzeAudio() {
    if (!this.audioBuffer || !this.selectedItemId) {
      this.uiController.showToast('请先从清单中选择一个音频文件', 'warning');
      return;
    }

    const startMs = parseInt(document.getElementById('startTime').value) || 0;
    const endMs = parseInt(document.getElementById('endTime').value) || 0;

    if (startMs >= endMs) {
      alert('请选择有效的时间区间');
      return;
    }

    logger.info('开始分析音频', { startMs, endMs });

    try {
      this.uiController.showLoading('正在分析音频...');

      // 获取 FFT 大小
      const fftSize = parseInt(document.getElementById('fftSize').value);

      // 提取选定区间的音频数据
      const startSample = Math.floor((startMs / 1000) * this.audioBuffer.sampleRate);
      const endSample = Math.floor((endMs / 1000) * this.audioBuffer.sampleRate);
      const channelData = this.audioBuffer.getChannelData(0);
      const selectedData = channelData.slice(startSample, endSample);

      // 分析音频
      const analysisResult = await this.audioAnalyzer.analyze(selectedData, this.audioBuffer.sampleRate, fftSize);

      logger.info('音频分析完成', {
        fundamentalFreq: analysisResult.fundamentalFreq,
        harmonicsCount: analysisResult.harmonics.length
      });

      // 保存当前分析结果
      this.currentAnalysisResult = analysisResult;

      // 更新图表
      this.chartManager.updateAllCharts(analysisResult, selectedData, this.audioBuffer.sampleRate);

      // 更新基频信息
      this.updateFundamentalInfo(analysisResult);

      // 显示图表区域
      document.getElementById('chartContainer').style.display = 'flex';
      document.getElementById('emptyState').style.display = 'none';

      // 显示保存记录区域
      document.getElementById('saveRecordSection').style.display = 'block';
      document.getElementById('recordName').value = `${this.currentFileName} - ${this.recordManager.formatTimestamp()}`;
      document.getElementById('recordNote').value = '';

      // 标记该清单文件已分析（再次上传不会重复堆积，且清单可见状态）
      this.fileQueue.markAnalyzed(this.selectedItemId, true);

    } catch (error) {
      logger.error('音频分析失败', error);
      alert('音频分析失败: ' + error.message);
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

  bindRecordEvents() {
    // 保存记录按钮
    document.getElementById('saveRecordBtn').addEventListener('click', () => this.saveRecord());

    // 展开/收起记录列表
    document.getElementById('toggleRecordsBtn').addEventListener('click', () => this.toggleRecordsPanel());

    // 关闭模态框
    document.getElementById('closeModalBtn').addEventListener('click', () => this.closeRecordModal());
    document.getElementById('recordDetailModal').addEventListener('click', (e) => {
      if (e.target.id === 'recordDetailModal') {
        this.closeRecordModal();
      }
    });

    // 应用记录
    document.getElementById('applyRecordBtn').addEventListener('click', () => this.applyRecord());

    // 删除记录
    document.getElementById('deleteRecordBtn').addEventListener('click', () => this.deleteRecord());
  }

  saveRecord() {
    if (!this.currentAnalysisResult) {
      this.uiController.showToast('没有可保存的分析结果', 'warning');
      return;
    }

    const name = document.getElementById('recordName').value.trim();
    const note = document.getElementById('recordNote').value.trim();
    const startMs = parseInt(document.getElementById('startTime').value) || 0;
    const endMs = parseInt(document.getElementById('endTime').value) || 0;

    const harmonicIntensities = this.extractHarmonicIntensities(this.currentAnalysisResult);

    try {
      const record = this.recordManager.createRecord({
        fileName: this.currentFileName,
        startMs,
        endMs,
        fundamentalFreq: this.currentAnalysisResult.fundamentalFreq,
        harmonics: this.currentAnalysisResult.harmonics,
        harmonicIntensities,
        analysisResult: this.currentAnalysisResult,
        name: name
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
    Object.keys(intensities).forEach(key => {
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

    recordsList.innerHTML = records.map(record => `
      <div class="record-item" data-id="${record.id}">
        <div class="record-main">
          <span class="record-name" title="${this.escapeHtml(record.name)}">${this.truncateText(record.name, 25)}</span>
          <span class="record-freq">${record.fundamentalFreq.toFixed(1)} Hz</span>
        </div>
        <div class="record-meta">
          <span class="record-file" title="${this.escapeHtml(record.fileName)}">${this.truncateText(record.fileName, 20)}</span>
          <span class="record-time">${this.recordManager.formatDate(record.createdAt)}</span>
        </div>
      </div>
    `).join('');

    recordsList.querySelectorAll('.record-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.id;
        this.showRecordDetail(id);
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

  // ========== 格式化工具 ==========

  /** 毫秒 -> mm:ss.s / h:mm:ss */
  formatDuration(ms) {
    if (ms == null) return '--';
    const totalSec = ms / 1000;
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = (totalSec % 60).toFixed(1).padStart(4, '0');
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${s.padStart(5, '0')}`;
    }
    return `${m}:${s}`;
  }

  formatSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  formatFileTimestamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  }

  escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }
}

// 启动应用
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});
