## How to Run

1. 确保已安装 Docker 和 Docker Compose

2. 在项目根目录执行：
```bash
docker-compose up --build -d
```

3. 访问应用：
- 用户端: http://localhost:8081

4. 停止服务：
```bash
docker-compose down
```

## Services

| 服务名称 | 端口 | 描述 |
|---------|------|------|
| frontend-user | 8081 | 古琴音频分析软件用户端 |

## 测试

### 测试音频

项目提供了测试音频文件 `frontend-user/public/test-guqin.wav`，可直接用于测试：
- 基频: 130.81 Hz (接近 C3)
- 时长: 3 秒
- 包含 13 次谐波，模拟古琴音色

### 功能测试

1. 批量上传音频文件
   - 点击或拖入一次可选择多个音频文件，形成待分析清单
   - 支持 MP3、WAV、OGG、M4A、FLAC 等常见音频格式
   - 清单中显示每个文件的时长、格式与大小，可移除、替换或点击切换为当前分析文件
   - 格式不支持或读取失败时逐条显示原因，可对单条点击"重试"
   - 已在清单中或已分析过的同名同大小文件不会重复堆积
   - 可一键将整份清单（含 manifest 清单文件）打包为 ZIP 下载留档
   - 清单通过浏览器本地存储持久化，重新打开页面后待分析项仍然可见
   - 文件大小建议不超过 10MB
   - 音频时长建议在 5 秒以内

2. 区间选择
   - 使用输入框精确输入起止时间（毫秒）
   - 使用滑块快速选择区间
   - 实时显示选中时长

3. 音频分析
   - 点击"分析音频"按钮开始分析
   - 自动检测基频
   - 显示最多 13 倍频

4. 图表验证
   - 波形图：显示选中区间的音频波形
   - 频谱图：显示基频和倍频的相对强度
   - 热力图：显示声强随时间的变化
   - 频率区域图：分别显示低频区、中频区、高频区

### 浏览器兼容性

- Chrome 80+
- Firefox 75+
- Safari 13+
- Edge 80+

---

# 古琴音频分析软件

专为斫琴师设计的音频频谱分析工具，用于分析古琴音色的基频、倍频和声强变化。

## 功能特性

- **批量音频上传**：支持多选/拖入多个 MP3、WAV、OGG、M4A、FLAC 等格式，形成待分析清单（显示时长与格式，可移除/替换/打包下载，刷新页面后仍保留）
- **精确截取**：以毫秒为单位精确选择分析区间
- **基频检测**：自动检测音频的基频
- **倍频分析**：显示最多 13 倍频，过滤其他频率
- **可视化图表**：
  - 波形图：显示音频波形
  - 频谱图：显示基频和倍频的强度分布
  - 热力图：显示声强随时间的变化
  - 频率区域图：分别显示低频区、中频区、高频区

## 技术栈

- 原生 JavaScript (ES6+)
- Web Audio API
- Chart.js
- Vite
- Nginx
- Docker

## 项目结构

```
├── frontend-user/          # 用户端前端项目
│   ├── src/
│   │   ├── modules/        # 功能模块
│   │   │   ├── audioAnalyzer.js   # 音频分析器
│   │   │   ├── chartManager.js    # 图表管理器
│   │   │   ├── fileQueueManager.js# 待分析清单（IndexedDB 持久化）
│   │   │   ├── recordManager.js   # 历史记录管理
│   │   │   └── uiController.js    # UI 控制器
│   │   ├── utils/          # 工具函数
│   │   │   ├── logger.js   # 日志工具
│   │   │   └── zip.js      # ZIP 打包工具（清单留档）
│   │   ├── styles/         # 样式文件
│   │   │   └── main.css    # 主样式
│   │   └── main.js         # 入口文件
│   ├── index.html          # HTML 模板
│   ├── Dockerfile          # Docker 构建文件
│   ├── nginx.conf          # Nginx 配置
│   ├── package.json        # 项目配置
│   └── vite.config.js      # Vite 配置
├── docker-compose.yml      # Docker Compose 配置
├── .gitignore              # Git 忽略文件
└── README.md               # 项目说明
```

## 本地开发

```bash
cd frontend-user
npm install
npm run dev
```

访问 http://localhost:8081

## 频率区域说明

- **低频区**：基频 ~ 4倍频
- **中频区**：5倍频 ~ 8倍频
- **高频区**：9倍频 ~ 13倍频

这三个区域共享同一个基频，用于分析古琴音色在不同频率范围的特征。
