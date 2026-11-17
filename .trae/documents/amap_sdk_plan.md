# 接入高德 JS SDK 并修复审查清单 Implementation Plan

## Repository Research

当前地图栈：
- **Leaflet 1.9.4** (cdnjs CDN，约 40KB gz) → map 容器、marker、polyline、click/drag 事件
- **AMap 栅格瓦片** (webrd0{s}.is.autonavi.com，GCJ-02，无 key) → 主底图
- **OSM 栅格** (tile.openstreetmap.org) → 瓦片加载失败时回退
- **自定义 GCJ 转换** (~15 行) → `wgs2gcj` / `gcj2wgs`，因为路线数据始终存 WGS-84，地图用 GCJ-02
- **AMap Web 服务 API v3** (restapi.amap.com) → 搜索/地理编码，硬编码 Key `AMAP_WEB_KEY = '289375feb...'`，Nominatim 作为无 Key 回退

内部不变量：**所有路线数据 (waypoints、fix 流、emitMarker) 一律 WGS-84**，仅在显示层做坐标转换。

审查清单中其他中等问题：
- `GITHUB_URL = Gegirhasut/route-spoofer` vs `UPDATE_REPO = wusheng666/route-spoofer` 不一致
- 页脚硬编码 `v1.1.12`
- `restore()` 导入 localStorage 时绕过 `validPoint` 校验
- `logFix(o)` 无 null-check，`o.lat.toFixed` 可能崩溃
- Clear 按钮守卫不一致：`$('clear').onclick` 有 `if(S.gpsOn) return`，`$('mapClear')` 没有
- `capacitor.config.json` 里 `allowMixedContent: true` 无必要
- `persist()` 无节流，`restore()` 无校验
- `build:android` 在 Windows 用了 `./gradlew` (bash)

## 方案

### 主改动：接入 AMap JS SDK (v2.0)

AMap JS SDK 是一套完整的前端地图库，自带：
- GCJ-02 底图（官方瓦片，无需自行拼 TileLayer URL）
- Marker / Polyline / Polygon / Circle 等覆盖物
- `AMap.PlaceSearch` / `AMap.Geocoder` / `AMap.RegeoGeocoder`（POI 搜索 + 地理编码 + 逆地理编码）
- `AMap.convertFrom(lnglat, 'gps')` / `AMap.convertTo(lnglat, 'gps')`（官方坐标系转换，精度比我们手写的更好）
- 国内 CDN (`webapi.amap.com` / `webst.amap.com`)

**两种运行模式共存**（根据用户是否在设置里填入 JS API Key 自动切换）：
1. **AMap SDK 模式**（JS Key 已配置）：底图+Marker+Polyline+搜索 全部走 AMap SDK，GCJ 转换用 SDK 内置方法
2. **Leaflet 模式**（JS Key 未配置）：保持现状（Leaflet + AMap 栅格瓦片 + Web 服务 API 搜索）

切换逻辑在应用启动时读取 `localStorage['amapJsKey']` 决定。

### 需注意的一个关键差异

AMap JS SDK 需要的 Key 类型是「**Web 端 (JS API)**」，当前硬编码的 Key 是「**Web 服务**」类型（用于 restapi.amap.com）。用户需在高德控制台申请一个 JS API 类型的 Key，填进设置页（或默认 `localStorage['amapJsKey']`）。

在 SDK 模式下 Web 服务 API Key 不再需要（SDK 的搜索/地理编码走不同端点 webapi.amap.com，Key 类型不同）。

## Files and Modules

### 主要改动
- `www/index.html`（唯一前端文件，约 3000 行）
  - `<head>`: `<link leaflet.css>` 改为条件加载 AMap SDK CSS，`<script leaflet.js>` 改为动态加载 AMap SDK（有 Key 才加）
  - 删除 `AMAP_TILE_URL` / `AMAP_TILE_OPTS` / `MAP_RASTER_URL` / `MAP_RASTER_OPTS` / `MAP_RASTER_ATTRIBUTION` 常量（Leaflet 分支保留）
  - 删除 `GCJ` 自定义转换函数（AMap 分支用 `AMap.convertFrom/convertTo`；Leaflet 分支保留自定义）
  - 新增 `AMAP_JS_KEY_CACHE` 常量、`initMap()` 初始化函数（根据是否有 Key 选择 AMap SDK 或 Leaflet）
  - `wgsLatLng()` / `fromMapLL()` 按分支拆：Leaflet 返回 `L.latLng()` / WGS，AMap 返回 GCJ `[lng, lat]` 数组
  - `map` 对象：两种类型都暴露统一的 API (`fitBounds`, `setFitView`, `addEventListener`)，用适配器桥接
  - `drawRoute()` / `refreshMarkers()` / 点击添加点 / 拖拽点 / `centerOnMap()` / `fitRouteOnMap()` / `map.on('click')` / `map.on('moveend')` 这些 Leaflet 方法全部按分支改写
  - 搜索：AMap 分支用 `AMap.PlaceSearch` / `AMap.Geocoder`，Leaflet 分支保留 Web 服务 API
  - `syncAttributionInset()` 适配 AMap 的 attribution 控件 DOM 结构
  - 所有 `L.` 前缀的全局调用改为分支安全
  - 修复审查清单问题（见下）

### 审查清单一并修复
- `GITHUB_URL` → `https://github.com/wusheng666/route-spoofer`（与 `UPDATE_REPO` 对齐）
- 页脚 `#appVersion` 内容改为从 release manifest 拉（或直接写 `v1.2.2` 占位，构建时注入更复杂，先手写）
- `restore()` 的 `d.waypoints` 加 `filter(validPoint)` 校验
- `logFix(o)` 所有字段做 null-check
- `$('clear').onclick` 去掉 `if(S.gpsOn) return`（`clearRoute()` 内部已有 `pressStop()`，守卫重复且导致行为不一致）
- `capacitor.config.json` 里 `allowMixedContent` 设为 `false`（或直接删，默认就是 false）
- `persist()` 加 100ms debounce，`restore()` / `loadRoutes()` 加内存缓存
- `build:android` 脚本改为跨平台（用 `shx` 或直接 PowerShell 语法）

### 次要改动
- `www/index.html`：新增一个 settings 里的 AMap JS API Key 输入框（可选）
- `capacitor.config.json`：移除 `allowMixedContent: true`
- `package.json` / `package-lock.json`：可选的话加 `shx` 依赖让 build:android 跨平台
- `.github/workflows/android.yml`：不改（已稳定）

## Implementation Steps

按依赖顺序：

1. **改 `capacitor.config.json`**：`allowMixedContent` → `false`
2. **改常量区**：新增 `AMAP_JS_KEY` 可配置项，删掉自定义 GCJ 函数（改为每个分支自己的实现）
3. **改 map 初始化**：`const map = L.map(...)` 改为 `initMap()` 工厂函数。有 JS Key 时 `new AMap.Map()` 并 `AMap.convertFrom`；否则保留 Leaflet。动态加载 AMap SDK 脚本 (`<script>` 注入)
4. **改 `toMapLL` / `fromMapLL`**：拆为 Leaflet/AMap 两个分支版本
5. **改 `centerOnMap` / `fitRouteOnMap`**：两种 map 的 fitBounds 不同 API（AMap 叫 `setFitView` + padding）
6. **改 `drawRoute`**：Leaflet → `L.polyline(...)`；AMap → `new AMap.Polyline(...)`
7. **改 `wpIcon` / `refreshMarkers`**：Leaflet → `L.marker({icon:L.divIcon(...)})`；AMap → `new AMap.Marker({content:'<div>...</div>'})`
8. **改 marker 拖拽**：AMap marker 的 drag 事件回调签名不同，且 marker.getPosition() 返回 GCJ → 需要 `convertTo`
9. **改点击添加点**：Leaflet `e.latlng` 是 GCJ（AMap 瓦片），AMap `e.lnglat` 是 GCJ → 都要转回 WGS
10. **改搜索 (`geocode()`)**：AMap 分支用 `new AMap.PlaceSearch({city:'全国'})` + `new AMap.Geocoder()`，结果坐标 GCJ → 转 WGS
11. **改 `map.on('moveend')` / `map.on('click')`**：AMap 事件签名不同
12. **改 `syncAttributionInset()`**：AMap attribution 在 `AMapBar` 控件里，DOM 结构不同
13. **修复审查清单的中等问题**（GITHUB_URL、restore 校验、logFix null-check、Clear 守卫、persist debounce、wpmSpeed clamp、build:android 脚本）
14. **`npx cap sync android`**（因为改了 capacitor.config.json）
15. **触发云端构建**

## Dependencies and Considerations

- **Key 类型差异**（风险点）：AMap JS API Key ≠ Web 服务 Key。用户现有的 `289375feb...` 是 Web 服务 Key，不能直接用于 JS SDK。SDK 分支没 Key 时自动回退到 Leaflet 分支。
- **AMap JS SDK 加载时机**：JS SDK 必须通过 `<script>` 标签同步加载（挂全局 `AMap`），不能 import。因为我们走 Capacitor（单 HTML 文件），可以动态注入 `<script>` 并等 `window.AMap` 可用后再初始化。
- **坐标 API 差异**：Leaflet 用 `[lat, lng]` 数组，AMap 用 `[lng, lat]` 或 `LngLat` 对象。转换点要小心顺序。
- **AMap attribution 要求**：官方要求必须显示版权信息（© 高德地图）。我们之前 Leaflet 的 attribution 控件已经有了，AMap SDK 也自带，保持显示即可。
- **AMap JS SDK v2.0 的安全密钥**：高德控制台现在建议配置「安全密钥」（securityJsCode），Key 必须配合密钥使用。`key={JS_KEY}&plugin=...` 在 v2.0 里可以不用 securityJsCode（但高德会警告）。为简化先不处理密钥，仅支持 Key 单参数模式；后续用户如需密钥再扩展。
- **Android 端 FileProvider / AppUpdater / MockLocationInjector** 这些原生代码 **完全不碰**，这次只是前端地图栈替换。
- **i18n 文案**：settings 里新增 "AMap JS API Key" 输入框的 label 和 hint 文案，8 种语言都加。

## Validation

- `npm run lint`（ESLint 全绿）
- 本地浏览器预览：Leaflet 路径（无 Key）正常
- 浏览器预览：设置 localStorage['amapJsKey'] 后 AMap 路径正常（需真实 Key，本地只能走 Leaflet）
- 云端构建 APK，验证：
  - classes.dex 不含新异常
  - web 资源正常加载
  - GitHub release manifest 正确
- 真机验证（有条件的话）：
  - SDK 模式下 map 正常渲染
  - 路线显示、拖拽、点击添加点、搜索 → GCJ/WGS 对齐无偏移
  - 无 Key 时自动回退 Leaflet 模式

## Risks

- **用户没有 JS API Key → SDK 路径全灰**：自动回退 Leaflet 模式 + 横幅提示「可在设置里配置高德 JS API Key 以获得最佳体验」
- **AMap JS SDK CDN 不可达**：动态脚本加载失败时自动回退 Leaflet 模式（已有 try-catch 包裹脚本注入）
- **坐标精度**：AMap 官方 `convertFrom/convertTo` 比我们手写的更准，不会恶化；万一 convertFrom 返回 null → 回退手写 GCJ 转换
- **AMap JS SDK 体积**：v2.0 主库 ~200KB gz，比 Leaflet 大，但 Capacitor WebView 内存充足，无感知
- **审查清单部分项留到后续**：PRD 里列的"i18n 抽 JSON、DOM 缓存、sampleAt 二分、persist debounce"这些属于性能优化，不在本次范围内，另开 issue
