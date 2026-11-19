"use strict";
/* Nullish fallback that also parses on pre-Chromium-80 WebViews (Android 8.x
   with an un-updated System WebView), where `??` / `?.` are syntax errors that
   would abort this whole inline script — leaving every control dead. */
function nz(v, d){ return v == null ? d : v; }
/* =====================================================================
   Route Spoofer — fake-GPS route player
   ---------------------------------------------------------------------
   Two execution modes share ONE UI:

   • NATIVE (Capacitor / Android): the playback clock + OS mock-location
     injection live in the native foreground service `MockLocationService`,
     driven through the `FakeGps` Kotlin plugin. The web layer is preview +
     control only; the moving marker, HUD, progress rail and emit log are
     driven by `fix` events streamed back from the native clock — never by a
     JS timer (which would freeze when the app is backgrounded).

   • BROWSER (desktop preview): the original requestAnimationFrame engine
     below runs locally so the page still previews without the plugin.

   `isNative` selects between the two; the route/speed/loop math is identical.
   ===================================================================== */

/* ---------- map providers ----------
   Two modes coexist:
     • AMap SDK mode — when localStorage['amapJsKey'] is set to a valid 高德
       Web端(JS API) key. Uses AMap JS SDK as the entire map layer (底图 + 搜索
       + 地理编码), calls AMap.convertFrom/convertTo for GCJ-02↔WGS-84.
     • Leaflet fallback — default, keeps the current architecture: Leaflet +
       keyless AMap raster tiles (GCJ-02) → OSM on failure. Custom GCJ transform
       below; search falls back to the existing Web 服务 API / Nominatim path.
   All route data + emitted fixes stay WGS-84 at all times — coordinate
   conversion only happens at the map display boundary. */
const MAP_AMAP_JS_KEY = '847b0f55961aff30d27bbc7d1bfe73d2';
const USING_AMAP = !!MAP_AMAP_JS_KEY;   // set at load time, immutable after
const AMAP_JS_SDK_URL = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(MAP_AMAP_JS_KEY);
const AMAP_TILE_URL = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';
const AMAP_TILE_OPTS = { subdomains:'1234', maxZoom:19, maxNativeZoom:18, attribution:'© <a href="https://www.amap.com/">高德地图</a>' };
const MAP_RASTER_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const MAP_RASTER_OPTS = { maxZoom:19 };
const MAP_RASTER_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/* ---------- WGS-84 <-> GCJ-02 ----------
   Leaflet fallback uses this hand-rolled transform (accurate enough).
   AMap SDK mode uses AMap.convertFrom(lnglat, 'gps') / .convertTo(..., 'gps')
   which is the official, precision-checked version — identical behaviour. */
const GCJ = (function(){
  const PI=Math.PI, A=6378245.0, EE=0.006693421622965943;
  const outOfChina=(lat,lng)=>!(lng>73.66 && lng<135.05 && lat>3.86 && lat<53.55);
  function tLat(x,y){
    let r=-100+2*x+3*y+0.2*y*y+0.1*x*y+0.2*Math.sqrt(Math.abs(x));
    r+=(20*Math.sin(6*x*PI)+20*Math.sin(2*x*PI))*2/3;
    r+=(20*Math.sin(y*PI)+40*Math.sin(y/3*PI))*2/3;
    r+=(160*Math.sin(y/12*PI)+320*Math.sin(y*PI/30))*2/3;
    return r;
  }
  function tLng(x,y){
    let r=300+x+2*y+0.1*x*x+0.1*x*y+0.1*Math.sqrt(Math.abs(x));
    r+=(20*Math.sin(6*x*PI)+20*Math.sin(2*x*PI))*2/3;
    r+=(20*Math.sin(x*PI)+40*Math.sin(x/3*PI))*2/3;
    r+=(150*Math.sin(x/12*PI)+300*Math.sin(x/30*PI))*2/3;
    return r;
  }
  function wgs2gcj(lat,lng){
    if(outOfChina(lat,lng)) return [lat,lng];
    let dLat=tLat(lng-105,lat-35), dLng=tLng(lng-105,lat-35);
    const radLat=lat/180*PI;
    const magic=1-EE*Math.sin(radLat)*Math.sin(radLat), sqrtMagic=Math.sqrt(magic);
    dLat=(dLat*180)/((A*(1-EE))/(magic*sqrtMagic)*PI);
    dLng=(dLng*180)/(A/sqrtMagic*Math.cos(radLat)*PI);
    return [lat+dLat,lng+dLng];
  }
  function gcj2wgs(lat,lng){
    if(outOfChina(lat,lng)) return [lat,lng];
    let wLat=lat, wLng=lng;
    for(let i=0;i<3;i++){ const g=wgs2gcj(wLat,wLng); wLat+=lat-g[0]; wLng+=lng-g[1]; }
    return [wLat,wLng];
  }
  return { wgs2gcj:wgs2gcj, gcj2wgs:gcj2wgs };
})();

/* Branch-aware coordinate helpers — every call site below uses these,
   so switching between AMap SDK and Leaflet is entirely contained here. */
let toMapLL, fromMapLL;

/* ---------- Capacitor / native plugin handles ---------- */
const Cap = window.Capacitor;
const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const FakeGps = isNative && Cap.Plugins ? Cap.Plugins.FakeGps : null;
const Browser = Cap && Cap.Plugins ? Cap.Plugins.Browser : null;
const Filesystem = isNative && Cap.Plugins ? Cap.Plugins.Filesystem : null;
const Share = isNative && Cap.Plugins ? Cap.Plugins.Share : null;
// GitHub-release updater (Android only); Play Store APIs are not used at all.
const AppUpdater = isNative && Cap.Plugins && Cap.getPlatform && Cap.getPlatform()==='android' ? Cap.Plugins.AppUpdater : null;

/* =====================================================================
   i18n — every user-facing string keyed by id. English is the source of
   truth and the fallback; t(key) returns the active language's string,
   falling back to English, then the key itself. Static UI nodes carry a
   data-i18n / data-i18n-title attribute and are (re)rendered by applyI18n().
   Brand name "Route Spoofer" stays untranslated in every locale.
   Note: Chinese (zh) and Hindi (hi) are machine translations pending review.
   ===================================================================== */
const GITHUB_URL = 'https://github.com/wusheng666/route-spoofer';
const I18N = {
  en: {
    'state.ready':'Ready','state.emitting':'Emitting','state.paused':'Paused',
    'status.standing':'Standing','status.driving':'Driving','status.arrived':'Arrived','status.waitingGo':'Waiting for GO','status.waitingAt':'Waiting','status.atWp':'at','gps.on':'GPS on','gps.off':'GPS off','go.go':'GO','go.pause':'Pause','wpm.dwell':'Wait here','wpm.none':'None','wpm.minutes':'minutes','wpm.untilGo':'Until GO','wpm.speed':'Speed to here (km/h)','wpm.remove':'Remove','wpm.close':'Close',
    'hud.speed':'Speed','hud.heading':'Heading','hud.progress':'Progress','hud.distance':'Distance',
    'hint.tapMap':'Tap the map to drop point A, then B, then C…','search.ph':'Search a place or address…','search.searching':'Searching…','search.notFound':'No place found.','search.error':'Search failed — try again.','routes.open':'Saved routes','routes.title':'Saved routes','routes.save':'Save current','routes.namePrompt':'Name this route:','routes.renamePrompt':'New name:','routes.search':'Filter routes…','routes.selectAll':'Select all','routes.clearSel':'Clear','routes.selected':'selected','routes.rename':'Rename','routes.delete':'Delete','routes.delSelected':'Delete selected','routes.exportSel':'Export selected','routes.exportAll':'Export all','routes.import':'Import','routes.deleteAll':'Delete all','routes.empty':'No saved routes yet.','routes.noMatch':'No routes match.','routes.full':'Limit reached (50) — delete or export some first.','routes.needPoints':'Add at least one point first.','routes.confirmDelete':'Delete this route?','routes.confirmDelSel':'Delete the selected routes?','routes.confirmDelAll':'Delete ALL saved routes?','routes.saved':'Route saved.','routes.loaded':'Route loaded.','routes.importBad':'Invalid file format.','routes.importDone':'Imported {a}, skipped {b}.','routes.noneSelected':'Select some routes first.','routes.exported':'Exported.','routes.exportErr':'Export failed.','routes.shareTitle':'Share routes',
    'live.seg':'seg','live.emit':'emit','live.elapsed':'elapsed','live.noRoute':'no route',
    'field.speed':'Speed','field.emitEvery':'Emit every','field.loop':'Loop','mode.walk':'Walk','mode.run':'Run','mode.bike':'Cycle','settings.title':'Settings','settings.speedsHint':'Speed for each mode in metres per second.',
    'loop.off':'Off','loop.restart':'Restart','loop.pingpong':'Ping-pong',
    'tool.myLocation':'My location','tool.reverse':'Reverse','tool.undo':'Undo','tool.clear':'Clear','tool.lock':'Lock','tool.locked':'Locked','map.clearRoute':'Clear route','map.clearConfirm':'Clear all points and start a new route?','locate.timeout':'Couldn\'t get your location','locate.stopPlayback':'Stop playback to find your real location','update.available':'Update available','update.download':'Download','update.downloading':'Downloading…','update.later':'Later','update.confirmStop':'Installing will stop the current playback. Continue?','update.allowInstall':'Allow installs from this app, then tap Download again.','update.badFile':'The download was corrupted. Try again.','update.failed':'Update failed. Try again later.',
    'log.summary':'Emitted fixes','log.waiting':'waiting for playback…',
    'setup.title':'Enable mock GPS',
    'setup.intro':'Route Spoofer needs two things before it can drive your device location.',
    'setup.check1title':'Location & notification permission',
    'setup.check1desc':'Allow access so the service can run.',
    'setup.check2title':'Selected as mock location app',
    'setup.check2desc':'Developer options → “Select mock location app” → Route Spoofer.',
    'setup.grant':'Grant permissions','setup.openDev':'Open Developer options',
    'setup.recheck':'Re-check','setup.dismiss':'Dismiss',
    'setup.granted':'Granted',
    'setup.check2help':'How to select the mock location app',
    'setup.pendingPerm':'Still waiting: grant location & notification permission.',
    'setup.pendingMock':'Still waiting: select Route Spoofer as the mock location app in Developer options.',
    'setup.stillChecking':'Couldn\'t read setup state — tap Re-check again.',
    'mock.title':'Select the mock location app',
    'mock.intro':'Point Android at Route Spoofer as its mock location source — a one-time setting.',
    'mock.step1':'Enable Developer options: Settings → About phone → tap Build number 7 times.',
    'mock.step1sub':'On Samsung: → Software information.',
    'mock.step2':'Open Settings → System → Developer options.',
    'mock.step3':'Tap “Select mock location app”.',
    'mock.step4':'Choose Route Spoofer.',
    'mock.note':'The exact path varies slightly by phone brand.',
    'mock.pending':'Not selected yet — choose Route Spoofer under “Select mock location app”.',
    'hint.locationBlocked':'Location is blocked. In Settings → Permissions, allow Location.',
    'dev.title':'Developer options are off',
    'dev.intro':'Mock GPS needs Android Developer options enabled — a one-time setting. Turn it on, then come back and re-check.',
    'dev.step1':'Open Settings → About phone','dev.step1sub':'On Samsung: → Software information.',
    'dev.step2':'Tap Build number 7 times','dev.step3':'Enter your PIN/password if asked',
    'dev.step4':'Come back here and tap Re-check',
    'dev.note':'The exact path varies slightly by phone brand.',
    'dev.openAbout':'Open About phone','dev.recheck':'Re-check','dev.close':'Close',
    'hint.dropFirst':'Drop at least one point first.','hint.needTwo':'Add a second point — GO drives between points.','hint.gpsFirst':'Turn GPS on first — tap the GPS button.','hint.routeComplete':'Route complete.',
    'hint.finishSetup':'Finish setup to start.','hint.couldNotStart':'Could not start mock service.',
    'hint.locating':'Locating…','hint.centered':'Centered on your location.',
    'hint.locationDenied':'Location is off — allow it in Settings to use this.','hint.geoUnavailable':'Geolocation unavailable.',
    'hint.locationTimeout':'No location fix yet — try again.','hint.centeredMock':'Centered on the location you are broadcasting.',
    'hint.ready':'Ready — tap play.','hint.openSettingsManual':'Open Developer options → Select mock location app → choose Route Spoofer.','hint.devOn':'Developer options on — now pick the mock app.',
    'hint.devStillOff':'Still off — enable Developer options to continue.',
    'wp.startRemove':'Start — tap to remove','wp.tapRemove':'Tap to remove',
    'title.play':'Play / pause','title.stop':'Stop & reset to start',
    'about.auto':'Auto','about.github':'View on GitHub','about.qa':'Beta-tested via',
    'link.openFailCopied':'Couldn’t open a browser. Link copied to clipboard: {url}','link.openFail':'Couldn’t open a browser. Open it manually: {url}',
    'help.title':'How it works','help.s1.t':'Two separate controls','help.s1.a':'GPS — turns location broadcasting on/off. When ON, the app feeds your position to the whole device (and any other app reads it as real). This is independent of movement.','help.s1.b':'GO / Pause — drives along your route. Only matters when GPS is ON and you have 2+ points.','help.s1.c':'With GPS ON and a single point, the driver just stands there and broadcasts.','help.s2.t':'Building a route','help.s2.a':'Tap the map to drop points (A, B, C…). Drag a point to move it.','help.s2.b':'While driving you can tap the map to append a new point to the end of the route.','help.s3.t':'Point options (long-press a point)','help.s3.a':'Wait N minutes — the driver stops here for the set time, then drives on automatically.','help.s3.b':'Wait until GO — the driver stops here and waits until you press GO.','help.s3.c':'Speed to here — set a custom km/h for the leg ending at this point (otherwise the global speed).','help.s3.d':'Remove — delete the point.','help.s4.t':'GO ends any wait early','help.s4.a':'Pressing GO immediately resumes driving from any stop — a timed wait, a wait-until-GO, or arrival — without waiting out the remaining time.','help.s5.t':'Edit anytime','help.s5.a':'Every point can be edited at any time — move it, change its dwell or speed, or remove it. Editing the route behind the driver keeps the current position steady.','help.s6.t':'End of route','help.s6.a':'At the last point the driver stops and keeps broadcasting that position — GPS does NOT switch off. Turning the GPS toggle OFF is the only thing that stops broadcasting. Add a new point and press GO to send the driver onward.','help.s7.t':'Speed','help.s7.a':'Pick Walk, Run or Cycle any time, even while driving, to change the pace live. Each mode\'s speed (m/s) is edited in Settings. Per-point speed overrides still apply to their leg.','help.s8.t':'Status label','help.s8.a':'Standing — parked, broadcasting. Driving — moving. Waiting m:ss at B — timed wait counting down. Waiting for GO — stopped until you press GO. Arrived — reached the end, still broadcasting.','help.compat.t':'Compatibility','help.compat.a':'Some map apps (e.g. Yandex Maps) use their own Wi-Fi/network positioning and may snap back to your real location. Disable Wi-Fi and mobile data while spoofing to avoid this.','help.s9.t':'Phone setup','help.s9.a':'Mock GPS needs Route Spoofer selected as the mock location app in Android Developer options. The readiness card walks you through it.','help.openSetup':'Open location settings','help.legGps':'GPS','help.legGo':'GO / Pause','help.legStop':'Stop','help.mapLeg.t':'Map legend','help.mapLeg.start':'Start (A)','help.mapLeg.up':'Upcoming / editable point','help.mapLeg.end':'Final point','help.lock.t':'Lock route','help.lock.a':'Tap Lock to protect the route from accidental edits — while locked, map taps and point drags are ignored, so a stray tap can\'t add or move points. Everything else (play, speed, loop…) keeps working.','help.lock.b':'Tap again to unlock and edit points as usual. Routes start unlocked.',
  },
  ru: {
    'state.ready':'Готов','state.emitting':'Передача','state.paused':'Пауза',
    'status.standing':'Стоит','status.driving':'Едет','status.arrived':'Прибыл','status.waitingGo':'Ожидание GO','status.waitingAt':'Ожидание','status.atWp':'у','gps.on':'GPS вкл','gps.off':'GPS выкл','go.go':'СТАРТ','go.pause':'Пауза','wpm.dwell':'Ждать здесь','wpm.none':'Нет','wpm.minutes':'минут','wpm.untilGo':'До GO','wpm.speed':'Скорость сюда (км/ч)','wpm.remove':'Удалить','wpm.close':'Закрыть',
    'hud.speed':'Скорость','hud.heading':'Курс','hud.progress':'Прогресс','hud.distance':'Расстояние',
    'hint.tapMap':'Коснитесь карты, чтобы поставить точку A, затем B, C…','search.ph':'Поиск места или адреса…','search.searching':'Поиск…','search.notFound':'Место не найдено.','search.error':'Ошибка поиска — повторите.','routes.open':'Сохранённые маршруты','routes.title':'Сохранённые маршруты','routes.save':'Сохранить текущий','routes.namePrompt':'Название маршрута:','routes.renamePrompt':'Новое название:','routes.search':'Фильтр маршрутов…','routes.selectAll':'Выбрать все','routes.clearSel':'Снять','routes.selected':'выбрано','routes.rename':'Переименовать','routes.delete':'Удалить','routes.delSelected':'Удалить выбранные','routes.exportSel':'Экспорт выбранных','routes.exportAll':'Экспорт всех','routes.import':'Импорт','routes.deleteAll':'Удалить все','routes.empty':'Пока нет сохранённых маршрутов.','routes.noMatch':'Нет совпадений.','routes.full':'Достигнут лимит (50) — сначала удалите или экспортируйте.','routes.needPoints':'Сначала поставьте хотя бы одну точку.','routes.confirmDelete':'Удалить этот маршрут?','routes.confirmDelSel':'Удалить выбранные маршруты?','routes.confirmDelAll':'Удалить ВСЕ сохранённые маршруты?','routes.saved':'Маршрут сохранён.','routes.loaded':'Маршрут загружен.','routes.importBad':'Неподходящий формат файла.','routes.importDone':'Импортировано {a}, пропущено {b}.','routes.noneSelected':'Сначала выберите маршруты.','routes.exported':'Экспортировано.','routes.exportErr':'Ошибка экспорта.','routes.shareTitle':'Поделиться маршрутами',
    'live.seg':'сегм','live.emit':'выдача','live.elapsed':'прошло','live.noRoute':'нет маршрута',
    'field.speed':'Скорость','field.emitEvery':'Передавать каждые','field.loop':'Цикл','mode.walk':'Ходьба','mode.run':'Бег','mode.bike':'Велосипед','settings.title':'Настройки','settings.speedsHint':'Скорость каждого режима в метрах в секунду.',
    'loop.off':'Выкл','loop.restart':'Заново','loop.pingpong':'Туда-обратно',
    'tool.myLocation':'Моё место','tool.reverse':'Реверс','tool.undo':'Отмена','tool.clear':'Очистить','tool.lock':'Заблокировать','tool.locked':'Заблокировано','map.clearRoute':'Очистить маршрут','map.clearConfirm':'Удалить все точки и начать новый маршрут?','locate.timeout':'Не удалось определить ваше местоположение','locate.stopPlayback':'Остановите воспроизведение, чтобы найти реальное местоположение','update.available':'Доступно обновление','update.download':'Скачать','update.downloading':'Скачивание…','update.later':'Позже','update.confirmStop':'Установка остановит текущее воспроизведение. Продолжить?','update.allowInstall':'Разрешите установку из этого приложения, затем нажмите «Скачать» ещё раз.','update.badFile':'Файл повреждён. Попробуйте снова.','update.failed':'Не удалось обновить. Попробуйте позже.',
    'log.summary':'Переданные точки','log.waiting':'ожидание воспроизведения…',
    'setup.title':'Включить фиктивный GPS',
    'setup.intro':'Route Spoofer нужно две вещи, чтобы управлять локацией устройства.',
    'setup.check1title':'Доступ к геолокации и уведомлениям',
    'setup.check1desc':'Разрешите доступ, чтобы служба работала.',
    'setup.check2title':'Выбрано приложение для фиктивной локации',
    'setup.check2desc':'Для разработчиков → «Приложение для фиктивных местоположений» → Route Spoofer.',
    'setup.grant':'Выдать разрешения','setup.openDev':'Открыть «Для разработчиков»',
    'setup.recheck':'Проверить снова','setup.dismiss':'Скрыть',
    'setup.granted':'Предоставлено',
    'setup.check2help':'Как выбрать приложение для имитации местоположения',
    'setup.pendingPerm':'Ещё нужно: разрешить доступ к геолокации и уведомлениям.',
    'setup.pendingMock':'Ещё нужно: выбрать Route Spoofer как приложение для имитации местоположения в параметрах разработчика.',
    'setup.stillChecking':'Не удалось прочитать состояние — нажмите «Проверить снова».',
    'mock.title':'Выбор приложения для имитации местоположения',
    'mock.intro':'Укажите Android, что Route Spoofer — источник имитации местоположения. Это однократная настройка.',
    'mock.step1':'Включите параметры разработчика: Настройки → О телефоне → 7 раз нажмите «Номер сборки».',
    'mock.step1sub':'На Samsung: → Сведения о ПО.',
    'mock.step2':'Откройте Настройки → Система → Для разработчиков.',
    'mock.step3':'Нажмите «Приложение для имитации местоположения».',
    'mock.step4':'Выберите Route Spoofer.',
    'mock.note':'Точный путь немного отличается у разных производителей.',
    'mock.pending':'Пока не выбрано — укажите Route Spoofer в «Приложение для имитации местоположения».',
    'hint.locationBlocked':'Геолокация заблокирована. В Настройках → Разрешения включите «Местоположение».',
    'dev.title':'Режим разработчика выключен',
    'dev.intro':'Фиктивному GPS нужны включённые «Параметры разработчика» Android — это разовая настройка. Включите их и вернитесь для повторной проверки.',
    'dev.step1':'Откройте Настройки → О телефоне','dev.step1sub':'На Samsung: → Сведения о ПО.',
    'dev.step2':'Нажмите «Номер сборки» 7 раз','dev.step3':'Введите PIN-код или пароль, если потребуется',
    'dev.step4':'Вернитесь сюда и нажмите «Проверить снова»',
    'dev.note':'Точный путь немного отличается у разных производителей.',
    'dev.openAbout':'Открыть «О телефоне»','dev.recheck':'Проверить снова','dev.close':'Закрыть',
    'hint.dropFirst':'Сначала поставьте хотя бы одну точку.','hint.needTwo':'Добавьте вторую точку — GO ведёт между точками.','hint.gpsFirst':'Сначала включите GPS — нажмите кнопку GPS.','hint.routeComplete':'Маршрут завершён.',
    'hint.finishSetup':'Завершите настройку для запуска.','hint.couldNotStart':'Не удалось запустить службу фиктивного GPS.',
    'hint.locating':'Определение…','hint.centered':'Карта по вашему местоположению.',
    'hint.locationDenied':'Геолокация выключена — включите её в настройках.','hint.geoUnavailable':'Геолокация недоступна.',
    'hint.locationTimeout':'Не удалось определить местоположение — попробуйте ещё раз.','hint.centeredMock':'Карта по точке, которую вы транслируете.',
    'hint.ready':'Готово — нажмите воспроизведение.','hint.openSettingsManual':'Откройте «Для разработчиков» → «Приложение для фиктивных местоположений» → выберите Route Spoofer.','hint.devOn':'Режим разработчика включён — выберите приложение для фиктивной локации.',
    'hint.devStillOff':'Всё ещё выключено — включите режим разработчика, чтобы продолжить.',
    'wp.startRemove':'Старт — нажмите, чтобы удалить','wp.tapRemove':'Нажмите, чтобы удалить',
    'title.play':'Воспроизвести / пауза','title.stop':'Стоп и сброс к началу',
    'about.auto':'Авто','about.github':'Открыть на GitHub','about.qa':'Бета-тестирование:',
    'link.openFailCopied':'Не удалось открыть браузер. Ссылка скопирована: {url}','link.openFail':'Не удалось открыть браузер. Откройте вручную: {url}',
    'help.title':'Как это работает','help.s1.t':'Два независимых элемента управления','help.s1.a':'GPS — включает/выключает трансляцию местоположения. Когда ВКЛ, приложение подаёт вашу позицию на всё устройство (и любое другое приложение считывает её как настоящую). Это не зависит от движения.','help.s1.b':'GO / Пауза — едет по вашему маршруту. Важно только когда GPS ВКЛ и у вас 2+ точки.','help.s1.c':'При GPS ВКЛ и одной точке водитель просто стоит и транслирует.','help.s2.t':'Построение маршрута','help.s2.a':'Коснитесь карты, чтобы поставить точки (A, B, C…). Перетащите точку, чтобы переместить её.','help.s2.b':'Во время движения можно коснуться карты, чтобы добавить новую точку в конец маршрута.','help.s3.t':'Параметры точки (долгое нажатие на точку)','help.s3.a':'Ждать N минут — водитель останавливается здесь на заданное время, затем едет дальше автоматически.','help.s3.b':'Ждать до GO — водитель останавливается здесь и ждёт, пока вы нажмёте GO.','help.s3.c':'Скорость до сюда — задайте свою км/ч для участка, заканчивающегося в этой точке (иначе используется общая скорость).','help.s3.d':'Удалить — удалить точку.','help.s4.t':'GO завершает любое ожидание досрочно','help.s4.a':'Нажатие GO мгновенно возобновляет движение из любой остановки — таймера, ожидания GO или прибытия — не дожидаясь оставшегося времени.','help.s5.t':'Редактирование в любой момент','help.s5.a':'Любую точку можно редактировать в любой момент — двигать, менять её ожидание или скорость, удалять. Редактирование маршрута позади водителя сохраняет текущую позицию (без скачка).','help.s6.t':'Конец маршрута','help.s6.a':'В последней точке водитель останавливается и продолжает транслировать эту позицию — GPS НЕ выключается. Только выключение переключателя GPS останавливает трансляцию. Добавьте новую точку и нажмите GO, чтобы отправить водителя дальше.','help.s7.t':'Скорость','help.s7.a':'Выбирайте ходьбу, бег или велосипед в любой момент, даже во время движения. Скорость каждого режима (м/с) настраивается в Настройках. Скорости отдельных точек по-прежнему применяются к своему участку.','help.s8.t':'Метка состояния','help.s8.a':'Стоит — припаркован, транслирует. Едет — в движении. Ожидание m:ss у B — обратный отсчёт таймера. Ожидание GO — стоит, пока вы не нажмёте GO. Прибыл — достиг конца, всё ещё транслирует.','help.compat.t':'Совместимость','help.compat.a':'Некоторые карты (например, Яндекс Карты) используют собственное определение по Wi-Fi/сети и могут вернуться к вашему реальному местоположению. Чтобы этого избежать, отключите Wi-Fi и мобильные данные во время подмены.','help.s9.t':'Настройка телефона','help.s9.a':'Фиктивному GPS нужно, чтобы Route Spoofer был выбран приложением для фиктивной локации в параметрах разработчика Android. Карточка готовности проведёт вас через это.','help.openSetup':'Открыть настройки локации','help.legGps':'GPS','help.legGo':'GO / Пауза','help.legStop':'Стоп','help.mapLeg.t':'Легенда карты','help.mapLeg.start':'Старт (A)','help.mapLeg.up':'Предстоящая / редактируемая точка','help.mapLeg.end':'Конечная точка','help.lock.t':'Блокировка маршрута','help.lock.a':'Нажмите «Заблокировать», чтобы защитить маршрут от случайных правок — пока он заблокирован, касания карты и перетаскивания точек игнорируются, поэтому случайное касание не добавит и не сдвинет точки. Всё остальное (воспроизведение, скорость, цикл…) продолжает работать.','help.lock.b':'Нажмите ещё раз, чтобы разблокировать и редактировать точки как обычно. Маршрут изначально разблокирован.',
  },
  de: {
    'state.ready':'Bereit','state.emitting':'Sendet','state.paused':'Pausiert',
    'status.standing':'Steht','status.driving':'Fährt','status.arrived':'Angekommen','status.waitingGo':'Warten auf GO','status.waitingAt':'Warten','status.atWp':'an','gps.on':'GPS an','gps.off':'GPS aus','go.go':'LOS','go.pause':'Pause','wpm.dwell':'Hier warten','wpm.none':'Keine','wpm.minutes':'Minuten','wpm.untilGo':'Bis LOS','wpm.speed':'Tempo hierher (km/h)','wpm.remove':'Entfernen','wpm.close':'Schließen',
    'hud.speed':'Tempo','hud.heading':'Kurs','hud.progress':'Fortschritt','hud.distance':'Distanz',
    'hint.tapMap':'Tippe auf die Karte für Punkt A, dann B, dann C…','search.ph':'Ort oder Adresse suchen…','search.searching':'Suche…','search.notFound':'Kein Ort gefunden.','search.error':'Suche fehlgeschlagen — erneut versuchen.','routes.open':'Gespeicherte Routen','routes.title':'Gespeicherte Routen','routes.save':'Aktuelle speichern','routes.namePrompt':'Route benennen:','routes.renamePrompt':'Neuer Name:','routes.search':'Routen filtern…','routes.selectAll':'Alle auswählen','routes.clearSel':'Leeren','routes.selected':'ausgewählt','routes.rename':'Umbenennen','routes.delete':'Löschen','routes.delSelected':'Auswahl löschen','routes.exportSel':'Auswahl exportieren','routes.exportAll':'Alle exportieren','routes.import':'Importieren','routes.deleteAll':'Alle löschen','routes.empty':'Noch keine gespeicherten Routen.','routes.noMatch':'Keine Routen gefunden.','routes.full':'Limit erreicht (50) — zuerst löschen oder exportieren.','routes.needPoints':'Zuerst mindestens einen Punkt setzen.','routes.confirmDelete':'Diese Route löschen?','routes.confirmDelSel':'Die ausgewählten Routen löschen?','routes.confirmDelAll':'ALLE gespeicherten Routen löschen?','routes.saved':'Route gespeichert.','routes.loaded':'Route geladen.','routes.importBad':'Ungültiges Dateiformat.','routes.importDone':'{a} importiert, {b} übersprungen.','routes.noneSelected':'Zuerst Routen auswählen.','routes.exported':'Exportiert.','routes.exportErr':'Export fehlgeschlagen.','routes.shareTitle':'Routen teilen',
    'live.seg':'Seg','live.emit':'Senden','live.elapsed':'Dauer','live.noRoute':'keine Route',
    'field.speed':'Tempo','field.emitEvery':'Senden alle','field.loop':'Schleife','mode.walk':'Gehen','mode.run':'Laufen','mode.bike':'Radfahren','settings.title':'Einstellungen','settings.speedsHint':'Geschwindigkeit je Modus in Metern pro Sekunde.',
    'loop.off':'Aus','loop.restart':'Neustart','loop.pingpong':'Pingpong',
    'tool.myLocation':'Mein Standort','tool.reverse':'Umkehren','tool.undo':'Rückgängig','tool.clear':'Löschen','tool.lock':'Sperren','tool.locked':'Gesperrt','map.clearRoute':'Route löschen','map.clearConfirm':'Alle Punkte löschen und eine neue Route beginnen?','locate.timeout':'Standort konnte nicht ermittelt werden','locate.stopPlayback':'Stoppe die Wiedergabe, um deinen echten Standort zu finden','update.available':'Update verfügbar','update.download':'Herunterladen','update.downloading':'Wird heruntergeladen…','update.later':'Später','update.confirmStop':'Die Installation beendet die aktuelle Wiedergabe. Fortfahren?','update.allowInstall':'Erlaube Installationen aus dieser App und tippe erneut auf Herunterladen.','update.badFile':'Die Datei ist beschädigt. Versuche es erneut.','update.failed':'Update fehlgeschlagen. Versuche es später erneut.',
    'log.summary':'Gesendete Punkte','log.waiting':'warte auf Wiedergabe…',
    'setup.title':'Mock-GPS aktivieren',
    'setup.intro':'Route Spoofer benötigt zwei Dinge, um deinen Gerätestandort zu steuern.',
    'setup.check1title':'Standort- und Benachrichtigungsberechtigung',
    'setup.check1desc':'Erlaube den Zugriff, damit der Dienst läuft.',
    'setup.check2title':'Als Mock-Standort-App ausgewählt',
    'setup.check2desc':'Entwickleroptionen → „App für simulierte Standorte“ → Route Spoofer.',
    'setup.grant':'Berechtigungen erteilen','setup.openDev':'Entwickleroptionen öffnen',
    'setup.recheck':'Erneut prüfen','setup.dismiss':'Schließen',
    'setup.granted':'Erteilt',
    'setup.check2help':'So wählst du die Mock-Standort-App',
    'setup.pendingPerm':'Fehlt noch: Standort- und Benachrichtigungsberechtigung erteilen.',
    'setup.pendingMock':'Fehlt noch: Route Spoofer in den Entwickleroptionen als Mock-Standort-App auswählen.',
    'setup.stillChecking':'Status nicht lesbar — erneut auf „Erneut prüfen“ tippen.',
    'mock.title':'Mock-Standort-App auswählen',
    'mock.intro':'Lege Route Spoofer als Mock-Standortquelle für Android fest — eine einmalige Einstellung.',
    'mock.step1':'Entwickleroptionen aktivieren: Einstellungen → Über das Telefon → 7-mal auf Build-Nummer tippen.',
    'mock.step1sub':'Bei Samsung: → Softwareinformationen.',
    'mock.step2':'Öffne Einstellungen → System → Entwickleroptionen.',
    'mock.step3':'Tippe auf „App für simulierte Standorte auswählen“.',
    'mock.step4':'Wähle Route Spoofer.',
    'mock.note':'Der genaue Pfad unterscheidet sich je nach Hersteller leicht.',
    'mock.pending':'Noch nicht ausgewählt — wähle Route Spoofer unter „App für simulierte Standorte auswählen“.',
    'hint.locationBlocked':'Standort ist blockiert. Erlaube ihn unter Einstellungen → Berechtigungen.',
    'dev.title':'Entwickleroptionen sind aus',
    'dev.intro':'Mock-GPS benötigt aktivierte Android-Entwickleroptionen – eine einmalige Einstellung. Aktiviere sie und prüfe dann erneut.',
    'dev.step1':'Öffne Einstellungen → Über das Telefon','dev.step1sub':'Bei Samsung: → Softwareinformationen.',
    'dev.step2':'Tippe 7-mal auf „Build-Nummer“','dev.step3':'Gib bei Aufforderung deine PIN/dein Passwort ein',
    'dev.step4':'Komm zurück und tippe auf „Erneut prüfen“',
    'dev.note':'Der genaue Pfad unterscheidet sich je nach Hersteller leicht.',
    'dev.openAbout':'Über das Telefon öffnen','dev.recheck':'Erneut prüfen','dev.close':'Schließen',
    'hint.dropFirst':'Setze zuerst mindestens einen Punkt.','hint.needTwo':'Setze einen zweiten Punkt — GO fährt zwischen Punkten.','hint.gpsFirst':'Schalte zuerst GPS ein — tippe auf die GPS-Taste.','hint.routeComplete':'Route abgeschlossen.',
    'hint.finishSetup':'Schließe die Einrichtung ab, um zu starten.','hint.couldNotStart':'Mock-Dienst konnte nicht gestartet werden.',
    'hint.locating':'Suche…','hint.centered':'Auf deinen Standort zentriert.',
    'hint.locationDenied':'Standort ist aus — erlaube ihn in den Einstellungen.','hint.geoUnavailable':'Standortdienst nicht verfügbar.',
    'hint.locationTimeout':'Noch keine Standortbestimmung — versuche es erneut.','hint.centeredMock':'Auf den Standort zentriert, den du sendest.',
    'hint.ready':'Bereit – tippe auf Wiedergabe.','hint.openSettingsManual':'Öffne Entwickleroptionen → App für simulierte Standorte → wähle Route Spoofer.','hint.devOn':'Entwickleroptionen an – wähle jetzt die Mock-App.',
    'hint.devStillOff':'Immer noch aus – aktiviere die Entwickleroptionen, um fortzufahren.',
    'wp.startRemove':'Start – tippen zum Entfernen','wp.tapRemove':'Tippen zum Entfernen',
    'title.play':'Wiedergabe / Pause','title.stop':'Stopp & zum Start zurücksetzen',
    'about.auto':'Auto','about.github':'Auf GitHub ansehen','about.qa':'Beta-getestet von',
    'link.openFailCopied':'Browser konnte nicht geöffnet werden. Link kopiert: {url}','link.openFail':'Browser konnte nicht geöffnet werden. Manuell öffnen: {url}',
    'help.title':'So funktioniert\'s','help.s1.t':'Zwei getrennte Steuerungen','help.s1.a':'GPS — schaltet die Standortübertragung ein/aus. Wenn AN, speist die App deine Position ins gesamte Gerät (und jede andere App liest sie als echt). Das ist unabhängig von der Bewegung.','help.s1.b':'LOS / Pause — fährt entlang deiner Route. Nur relevant, wenn GPS AN ist und du 2+ Punkte hast.','help.s1.c':'Mit GPS AN und einem einzigen Punkt steht der Fahrer einfach da und sendet.','help.s2.t':'Eine Route bauen','help.s2.a':'Tippe auf die Karte, um Punkte zu setzen (A, B, C…). Ziehe einen Punkt, um ihn zu verschieben.','help.s2.b':'Während der Fahrt kannst du auf die Karte tippen, um einen neuen Punkt ans Routenende anzuhängen.','help.s3.t':'Punkt-Optionen (langer Druck auf einen Punkt)','help.s3.a':'N Minuten warten — der Fahrer hält hier für die eingestellte Zeit und fährt dann automatisch weiter.','help.s3.b':'Bis LOS warten — der Fahrer hält hier und wartet, bis du LOS drückst.','help.s3.c':'Tempo bis hierher — lege ein eigenes km/h für das bei diesem Punkt endende Teilstück fest (sonst das globale Tempo).','help.s3.d':'Entfernen — den Punkt löschen.','help.s4.t':'LOS beendet jede Wartezeit vorzeitig','help.s4.a':'LOS zu drücken setzt die Fahrt sofort aus jedem Halt fort — einer zeitlichen Wartezeit, einem Warten-bis-LOS oder der Ankunft — ohne die restliche Zeit abzuwarten.','help.s5.t':'Jederzeit bearbeiten','help.s5.a':'Jeder Punkt kann jederzeit bearbeitet werden — verschieben, Wartezeit oder Tempo ändern oder entfernen. Bearbeitungen hinter dem Fahrer halten die aktuelle Position stabil (kein Sprung).','help.s6.t':'Routenende','help.s6.a':'Am letzten Punkt hält der Fahrer und sendet diese Position weiter — GPS schaltet sich NICHT ab. Nur das Ausschalten des GPS-Schalters stoppt das Senden. Füge einen neuen Punkt hinzu und drücke LOS, um den Fahrer weiterzuschicken.','help.s7.t':'Tempo','help.s7.a':'Wähle jederzeit Gehen, Laufen oder Radfahren – auch während der Fahrt. Die Geschwindigkeit jedes Modus (m/s) stellst du in den Einstellungen ein. Punkt-Spezifische Tempos gelten weiterhin für ihr Teilstück.','help.s8.t':'Statusanzeige','help.s8.a':'Steht — geparkt, sendet. Fährt — in Bewegung. Warten m:ss an B — zeitlicher Countdown. Warten auf LOS — hält, bis du LOS drückst. Angekommen — Ende erreicht, sendet weiter.','help.compat.t':'Kompatibilität','help.compat.a':'Manche Karten-Apps (z. B. Yandex Maps) nutzen eigene WLAN-/Netzwerk-Ortung und springen evtl. auf deinen echten Standort zurück. Schalte WLAN und mobile Daten beim Spoofen aus, um das zu vermeiden.','help.s9.t':'Telefon einrichten','help.s9.a':'Mock-GPS benötigt, dass Route Spoofer in den Android-Entwickleroptionen als Mock-Standort-App ausgewählt ist. Die Bereitschaftskarte führt dich durch.','help.openSetup':'Standorteinstellungen öffnen','help.legGps':'GPS','help.legGo':'LOS / Pause','help.legStop':'Stopp','help.mapLeg.t':'Kartenlegende','help.mapLeg.start':'Start (A)','help.mapLeg.up':'Kommender / bearbeitbarer Punkt','help.mapLeg.end':'Endpunkt','help.lock.t':'Route sperren','help.lock.a':'Tippe auf Sperren, um die Route vor versehentlichen Änderungen zu schützen — solange gesperrt, werden Kartentipps und das Ziehen von Punkten ignoriert, sodass ein versehentlicher Tipp keine Punkte hinzufügt oder verschiebt. Alles andere (Fahren, Tempo, Schleife…) funktioniert weiter.','help.lock.b':'Tippe erneut, um zu entsperren und Punkte wie gewohnt zu bearbeiten. Routen starten entsperrt.',
  },
  es: {
    'state.ready':'Listo','state.emitting':'Emitiendo','state.paused':'En pausa',
    'status.standing':'Parado','status.driving':'Conduciendo','status.arrived':'Llegó','status.waitingGo':'Esperando GO','status.waitingAt':'Esperando','status.atWp':'en','gps.on':'GPS act.','gps.off':'GPS desact.','go.go':'IR','go.pause':'Pausa','wpm.dwell':'Esperar aquí','wpm.none':'Ninguna','wpm.minutes':'minutos','wpm.untilGo':'Hasta IR','wpm.speed':'Velocidad hasta aquí (km/h)','wpm.remove':'Eliminar','wpm.close':'Cerrar',
    'hud.speed':'Velocidad','hud.heading':'Rumbo','hud.progress':'Progreso','hud.distance':'Distancia',
    'hint.tapMap':'Toca el mapa para poner el punto A, luego B, luego C…','search.ph':'Buscar un lugar o dirección…','search.searching':'Buscando…','search.notFound':'No se encontró el lugar.','search.error':'Error de búsqueda — inténtalo de nuevo.','routes.open':'Rutas guardadas','routes.title':'Rutas guardadas','routes.save':'Guardar actual','routes.namePrompt':'Nombra esta ruta:','routes.renamePrompt':'Nuevo nombre:','routes.search':'Filtrar rutas…','routes.selectAll':'Seleccionar todo','routes.clearSel':'Limpiar','routes.selected':'seleccionadas','routes.rename':'Renombrar','routes.delete':'Eliminar','routes.delSelected':'Eliminar seleccionadas','routes.exportSel':'Exportar seleccionadas','routes.exportAll':'Exportar todo','routes.import':'Importar','routes.deleteAll':'Eliminar todo','routes.empty':'Aún no hay rutas guardadas.','routes.noMatch':'Ninguna ruta coincide.','routes.full':'Límite alcanzado (50): elimina o exporta algunas primero.','routes.needPoints':'Añade al menos un punto primero.','routes.confirmDelete':'¿Eliminar esta ruta?','routes.confirmDelSel':'¿Eliminar las rutas seleccionadas?','routes.confirmDelAll':'¿Eliminar TODAS las rutas guardadas?','routes.saved':'Ruta guardada.','routes.loaded':'Ruta cargada.','routes.importBad':'Formato de archivo no válido.','routes.importDone':'Importadas {a}, omitidas {b}.','routes.noneSelected':'Selecciona algunas rutas primero.','routes.exported':'Exportado.','routes.exportErr':'Error al exportar.','routes.shareTitle':'Compartir rutas',
    'live.seg':'seg','live.emit':'emisión','live.elapsed':'tiempo','live.noRoute':'sin ruta',
    'field.speed':'Velocidad','field.emitEvery':'Emitir cada','field.loop':'Bucle','mode.walk':'Caminar','mode.run':'Correr','mode.bike':'Bici','settings.title':'Ajustes','settings.speedsHint':'Velocidad de cada modo en metros por segundo.',
    'loop.off':'No','loop.restart':'Reiniciar','loop.pingpong':'Ida y vuelta',
    'tool.myLocation':'Mi ubicación','tool.reverse':'Invertir','tool.undo':'Deshacer','tool.clear':'Borrar','tool.lock':'Bloquear','tool.locked':'Bloqueado','map.clearRoute':'Borrar ruta','map.clearConfirm':'¿Borrar todos los puntos y empezar una nueva ruta?','locate.timeout':'No se pudo obtener tu ubicación','locate.stopPlayback':'Detén la reproducción para ver tu ubicación real','update.available':'Actualización disponible','update.download':'Descargar','update.downloading':'Descargando…','update.later':'Más tarde','update.confirmStop':'La instalación detendrá la reproducción actual. ¿Continuar?','update.allowInstall':'Permite instalar desde esta app y pulsa Descargar de nuevo.','update.badFile':'El archivo está dañado. Inténtalo de nuevo.','update.failed':'No se pudo actualizar. Inténtalo más tarde.',
    'log.summary':'Puntos emitidos','log.waiting':'esperando reproducción…',
    'setup.title':'Activar GPS simulado',
    'setup.intro':'Route Spoofer necesita dos cosas antes de controlar la ubicación de tu dispositivo.',
    'setup.check1title':'Permiso de ubicación y notificaciones',
    'setup.check1desc':'Permite el acceso para que el servicio funcione.',
    'setup.check2title':'Seleccionada como app de ubicación simulada',
    'setup.check2desc':'Opciones de desarrollador → «Aplicación de ubicaciones simuladas» → Route Spoofer.',
    'setup.grant':'Conceder permisos','setup.openDev':'Abrir opciones de desarrollador',
    'setup.recheck':'Volver a comprobar','setup.dismiss':'Descartar',
    'setup.granted':'Concedido',
    'setup.check2help':'Cómo seleccionar la app de ubicación simulada',
    'setup.pendingPerm':'Aún falta: conceder permiso de ubicación y notificaciones.',
    'setup.pendingMock':'Aún falta: seleccionar Route Spoofer como app de ubicación simulada en Opciones de desarrollador.',
    'setup.stillChecking':'No se pudo leer el estado — pulsa «Volver a comprobar».',
    'mock.title':'Seleccionar la app de ubicación simulada',
    'mock.intro':'Indica a Android que Route Spoofer es su fuente de ubicación simulada — un ajuste único.',
    'mock.step1':'Activa Opciones de desarrollador: Ajustes → Información del teléfono → toca Número de compilación 7 veces.',
    'mock.step1sub':'En Samsung: → Información de software.',
    'mock.step2':'Abre Ajustes → Sistema → Opciones de desarrollador.',
    'mock.step3':'Toca «Seleccionar app de ubicación simulada».',
    'mock.step4':'Elige Route Spoofer.',
    'mock.note':'La ruta exacta varía un poco según la marca del teléfono.',
    'mock.pending':'Aún no seleccionada — elige Route Spoofer en «Seleccionar app de ubicación simulada».',
    'hint.locationBlocked':'La ubicación está bloqueada. En Ajustes → Permisos, permite la Ubicación.',
    'dev.title':'Las opciones de desarrollador están desactivadas',
    'dev.intro':'El GPS simulado necesita las opciones de desarrollador de Android activadas, un ajuste único. Actívalas y vuelve a comprobar.',
    'dev.step1':'Abre Ajustes → Información del teléfono','dev.step1sub':'En Samsung: → Información de software.',
    'dev.step2':'Toca «Número de compilación» 7 veces','dev.step3':'Introduce tu PIN/contraseña si se solicita',
    'dev.step4':'Vuelve aquí y toca «Volver a comprobar»',
    'dev.note':'La ruta exacta varía un poco según la marca del teléfono.',
    'dev.openAbout':'Abrir Información del teléfono','dev.recheck':'Volver a comprobar','dev.close':'Cerrar',
    'hint.dropFirst':'Pon al menos un punto primero.','hint.needTwo':'Añade un segundo punto: IR conduce entre puntos.','hint.gpsFirst':'Enciende el GPS primero: toca el botón de GPS.','hint.routeComplete':'Ruta completada.',
    'hint.finishSetup':'Completa la configuración para empezar.','hint.couldNotStart':'No se pudo iniciar el servicio simulado.',
    'hint.locating':'Localizando…','hint.centered':'Centrado en tu ubicación.',
    'hint.locationDenied':'La ubicación está desactivada — actívala en Ajustes.','hint.geoUnavailable':'Geolocalización no disponible.',
    'hint.locationTimeout':'Aún no hay ubicación — inténtalo de nuevo.','hint.centeredMock':'Centrado en la ubicación que estás emitiendo.',
    'hint.ready':'Listo: toca reproducir.','hint.openSettingsManual':'Abre Opciones de desarrollador → Seleccionar app de ubicación simulada → elige Route Spoofer.','hint.devOn':'Opciones de desarrollador activadas: elige la app de ubicación simulada.',
    'hint.devStillOff':'Sigue desactivado: activa las opciones de desarrollador para continuar.',
    'wp.startRemove':'Inicio: toca para eliminar','wp.tapRemove':'Toca para eliminar',
    'title.play':'Reproducir / pausar','title.stop':'Detener y volver al inicio',
    'about.auto':'Auto','about.github':'Ver en GitHub','about.qa':'Beta-probado por',
    'link.openFailCopied':'No se pudo abrir un navegador. Enlace copiado: {url}','link.openFail':'No se pudo abrir un navegador. Ábrelo manualmente: {url}',
    'help.title':'Cómo funciona','help.s1.t':'Dos controles separados','help.s1.a':'GPS — activa/desactiva la transmisión de ubicación. Cuando está ON, la app envía tu posición a todo el dispositivo (y cualquier otra app la lee como real). Esto es independiente del movimiento.','help.s1.b':'IR / Pausa — conduce por tu ruta. Solo importa cuando el GPS está ON y tienes 2+ puntos.','help.s1.c':'Con el GPS ON y un solo punto, el conductor simplemente se queda ahí y transmite.','help.s2.t':'Crear una ruta','help.s2.a':'Toca el mapa para colocar puntos (A, B, C…). Arrastra un punto para moverlo.','help.s2.b':'Mientras conduces puedes tocar el mapa para añadir un nuevo punto al final de la ruta.','help.s3.t':'Opciones del punto (mantén pulsado un punto)','help.s3.a':'Esperar N minutos — el conductor se detiene aquí el tiempo fijado y luego sigue automáticamente.','help.s3.b':'Esperar hasta IR — el conductor se detiene aquí y espera hasta que pulses IR.','help.s3.c':'Velocidad hasta aquí — fija una km/h propia para el tramo que termina en este punto (si no, la velocidad global).','help.s3.d':'Eliminar — borra el punto.','help.s4.t':'IR termina cualquier espera antes de tiempo','help.s4.a':'Pulsar IR reanuda de inmediato la conducción desde cualquier parada — una espera con tiempo, una espera hasta IR o la llegada — sin agotar el tiempo restante.','help.s5.t':'Edita en cualquier momento','help.s5.a':'Cada punto se puede editar en cualquier momento — moverlo, cambiar su espera o velocidad, o eliminarlo. Editar la ruta por detrás del conductor mantiene la posición actual estable (sin saltos).','help.s6.t':'Fin de la ruta','help.s6.a':'En el último punto el conductor se detiene y sigue transmitiendo esa posición — el GPS NO se apaga. Apagar el interruptor de GPS es lo único que detiene la transmisión. Añade un nuevo punto y pulsa IR para enviar al conductor más allá.','help.s7.t':'Velocidad','help.s7.a':'Elige Caminar, Correr o Bici en cualquier momento, incluso conduciendo. La velocidad de cada modo (m/s) se edita en Ajustes. Las velocidades por punto siguen aplicándose a su tramo.','help.s8.t':'Etiqueta de estado','help.s8.a':'Parado — estacionado, transmitiendo. Conduciendo — en movimiento. Esperando m:ss en B — cuenta atrás. Esperando IR — detenido hasta que pulses IR. Llegó — alcanzó el final, sigue transmitiendo.','help.compat.t':'Compatibilidad','help.compat.a':'Algunas apps de mapas (p. ej. Yandex Maps) usan su propia ubicación por Wi-Fi/red y pueden volver a tu ubicación real. Desactiva el Wi-Fi y los datos móviles mientras simulas para evitarlo.','help.s9.t':'Configuración del teléfono','help.s9.a':'El GPS simulado necesita que Route Spoofer esté seleccionada como app de ubicación simulada en las opciones de desarrollador de Android. La tarjeta de listo te guía.','help.openSetup':'Abrir ajustes de ubicación','help.legGps':'GPS','help.legGo':'IR / Pausa','help.legStop':'Detener','help.mapLeg.t':'Leyenda del mapa','help.mapLeg.start':'Inicio (A)','help.mapLeg.up':'Punto próximo / editable','help.mapLeg.end':'Punto final','help.lock.t':'Bloquear ruta','help.lock.a':'Toca Bloquear para proteger la ruta de ediciones accidentales — mientras está bloqueada, los toques en el mapa y el arrastre de puntos se ignoran, así que un toque accidental no puede añadir ni mover puntos. Todo lo demás (reproducción, velocidad, bucle…) sigue funcionando.','help.lock.b':'Toca de nuevo para desbloquear y editar los puntos como siempre. Las rutas empiezan desbloqueadas.',
  },
  pt: {
    'state.ready':'Pronto','state.emitting':'Emitindo','state.paused':'Pausado',
    'status.standing':'Parado','status.driving':'Dirigindo','status.arrived':'Chegou','status.waitingGo':'Aguardando GO','status.waitingAt':'Aguardando','status.atWp':'em','gps.on':'GPS lig.','gps.off':'GPS desl.','go.go':'IR','go.pause':'Pausar','wpm.dwell':'Esperar aqui','wpm.none':'Nenhuma','wpm.minutes':'minutos','wpm.untilGo':'Até IR','wpm.speed':'Velocidade até aqui (km/h)','wpm.remove':'Remover','wpm.close':'Fechar',
    'hud.speed':'Velocidade','hud.heading':'Direção','hud.progress':'Progresso','hud.distance':'Distância',
    'hint.tapMap':'Toque no mapa para marcar o ponto A, depois B, depois C…','search.ph':'Buscar um lugar ou endereço…','search.searching':'Buscando…','search.notFound':'Nenhum lugar encontrado.','search.error':'Falha na busca — tente de novo.','routes.open':'Rotas salvas','routes.title':'Rotas salvas','routes.save':'Salvar atual','routes.namePrompt':'Nomeie esta rota:','routes.renamePrompt':'Novo nome:','routes.search':'Filtrar rotas…','routes.selectAll':'Selecionar tudo','routes.clearSel':'Limpar','routes.selected':'selecionadas','routes.rename':'Renomear','routes.delete':'Excluir','routes.delSelected':'Excluir selecionadas','routes.exportSel':'Exportar selecionadas','routes.exportAll':'Exportar tudo','routes.import':'Importar','routes.deleteAll':'Excluir tudo','routes.empty':'Ainda não há rotas salvas.','routes.noMatch':'Nenhuma rota corresponde.','routes.full':'Limite atingido (50) — exclua ou exporte algumas primeiro.','routes.needPoints':'Adicione pelo menos um ponto primeiro.','routes.confirmDelete':'Excluir esta rota?','routes.confirmDelSel':'Excluir as rotas selecionadas?','routes.confirmDelAll':'Excluir TODAS as rotas salvas?','routes.saved':'Rota salva.','routes.loaded':'Rota carregada.','routes.importBad':'Formato de arquivo inválido.','routes.importDone':'Importadas {a}, ignoradas {b}.','routes.noneSelected':'Selecione algumas rotas primeiro.','routes.exported':'Exportado.','routes.exportErr':'Falha ao exportar.','routes.shareTitle':'Compartilhar rotas',
    'live.seg':'seg','live.emit':'emissão','live.elapsed':'tempo','live.noRoute':'sem rota',
    'field.speed':'Velocidade','field.emitEvery':'Emitir a cada','field.loop':'Repetição','mode.walk':'Caminhada','mode.run':'Corrida','mode.bike':'Bicicleta','settings.title':'Configurações','settings.speedsHint':'Velocidade de cada modo em metros por segundo.',
    'loop.off':'Desl.','loop.restart':'Reiniciar','loop.pingpong':'Vai e volta',
    'tool.myLocation':'Meu local','tool.reverse':'Inverter','tool.undo':'Desfazer','tool.clear':'Limpar','tool.lock':'Bloquear','tool.locked':'Bloqueado','map.clearRoute':'Limpar rota','map.clearConfirm':'Apagar todos os pontos e começar uma nova rota?','locate.timeout':'Não foi possível obter sua localização','locate.stopPlayback':'Pare a reprodução para ver sua localização real','update.available':'Atualização disponível','update.download':'Baixar','update.downloading':'Baixando…','update.later':'Depois','update.confirmStop':'A instalação interromperá a reprodução atual. Continuar?','update.allowInstall':'Permita instalações deste app e toque em Baixar novamente.','update.badFile':'O arquivo está corrompido. Tente novamente.','update.failed':'Falha na atualização. Tente mais tarde.',
    'log.summary':'Pontos emitidos','log.waiting':'aguardando reprodução…',
    'setup.title':'Ativar GPS falso',
    'setup.intro':'O Route Spoofer precisa de duas coisas antes de controlar a localização do aparelho.',
    'setup.check1title':'Permissão de localização e notificações',
    'setup.check1desc':'Permita o acesso para o serviço funcionar.',
    'setup.check2title':'Selecionado como app de localização falsa',
    'setup.check2desc':'Opções do desenvolvedor → «Aplicativo de localização fictícia» → Route Spoofer.',
    'setup.grant':'Conceder permissões','setup.openDev':'Abrir opções do desenvolvedor',
    'setup.recheck':'Verificar de novo','setup.dismiss':'Dispensar',
    'setup.granted':'Concedida',
    'setup.check2help':'Como selecionar o app de localização simulada',
    'setup.pendingPerm':'Ainda falta: conceder permissão de localização e notificações.',
    'setup.pendingMock':'Ainda falta: selecionar o Route Spoofer como app de localização simulada nas Opções do desenvolvedor.',
    'setup.stillChecking':'Não foi possível ler o estado — toque em «Verificar de novo».',
    'mock.title':'Selecionar o app de localização simulada',
    'mock.intro':'Defina o Route Spoofer como fonte de localização simulada do Android — uma configuração única.',
    'mock.step1':'Ative as Opções do desenvolvedor: Configurações → Sobre o telefone → toque em Número da versão 7 vezes.',
    'mock.step1sub':'Na Samsung: → Informações de software.',
    'mock.step2':'Abra Configurações → Sistema → Opções do desenvolvedor.',
    'mock.step3':'Toque em «Selecionar app de localização simulada».',
    'mock.step4':'Escolha o Route Spoofer.',
    'mock.note':'O caminho exato varia um pouco conforme a marca do aparelho.',
    'mock.pending':'Ainda não selecionado — escolha o Route Spoofer em «Selecionar app de localização simulada».',
    'hint.locationBlocked':'A localização está bloqueada. Em Configurações → Permissões, permita a Localização.',
    'dev.title':'As opções do desenvolvedor estão desativadas',
    'dev.intro':'O GPS falso precisa das opções do desenvolvedor do Android ativadas — um ajuste único. Ative-as e verifique de novo.',
    'dev.step1':'Abra Configurações → Sobre o telefone','dev.step1sub':'No Samsung: → Informações de software.',
    'dev.step2':'Toque em «Número da versão» 7 vezes','dev.step3':'Digite seu PIN/senha se for solicitado',
    'dev.step4':'Volte aqui e toque em «Verificar de novo»',
    'dev.note':'O caminho exato varia um pouco conforme a marca do aparelho.',
    'dev.openAbout':'Abrir Sobre o telefone','dev.recheck':'Verificar de novo','dev.close':'Fechar',
    'hint.dropFirst':'Marque ao menos um ponto primeiro.','hint.needTwo':'Adicione um segundo ponto — IR dirige entre pontos.','hint.gpsFirst':'Ligue o GPS primeiro — toque no botão de GPS.','hint.routeComplete':'Rota concluída.',
    'hint.finishSetup':'Conclua a configuração para iniciar.','hint.couldNotStart':'Não foi possível iniciar o serviço falso.',
    'hint.locating':'Localizando…','hint.centered':'Centralizado na sua localização.',
    'hint.locationDenied':'A localização está desativada — ative-a nas Configurações.','hint.geoUnavailable':'Geolocalização indisponível.',
    'hint.locationTimeout':'Ainda sem localização — tente novamente.','hint.centeredMock':'Centralizado na localização que você está transmitindo.',
    'hint.ready':'Pronto — toque em reproduzir.','hint.openSettingsManual':'Abra Opções do desenvolvedor → Selecionar app de localização simulada → escolha Route Spoofer.','hint.devOn':'Opções do desenvolvedor ativadas — escolha o app de localização falsa.',
    'hint.devStillOff':'Ainda desativado — ative as opções do desenvolvedor para continuar.',
    'wp.startRemove':'Início — toque para remover','wp.tapRemove':'Toque para remover',
    'title.play':'Reproduzir / pausar','title.stop':'Parar e voltar ao início',
    'about.auto':'Auto','about.github':'Ver no GitHub','about.qa':'Testado em beta por',
    'link.openFailCopied':'Não foi possível abrir um navegador. Link copiado: {url}','link.openFail':'Não foi possível abrir um navegador. Abra manualmente: {url}',
    'help.title':'Como funciona','help.s1.t':'Dois controles separados','help.s1.a':'GPS — liga/desliga a transmissão de localização. Quando LIGADO, o app envia sua posição para todo o aparelho (e qualquer outro app a lê como real). Isto é independente do movimento.','help.s1.b':'IR / Pausar — dirige pela sua rota. Só importa quando o GPS está LIGADO e você tem 2+ pontos.','help.s1.c':'Com o GPS LIGADO e um único ponto, o motorista apenas fica ali e transmite.','help.s2.t':'Montar uma rota','help.s2.a':'Toque no mapa para marcar pontos (A, B, C…). Arraste um ponto para movê-lo.','help.s2.b':'Enquanto dirige, você pode tocar no mapa para anexar um novo ponto ao fim da rota.','help.s3.t':'Opções do ponto (toque e segure um ponto)','help.s3.a':'Esperar N minutos — o motorista para aqui pelo tempo definido e depois segue automaticamente.','help.s3.b':'Esperar até IR — o motorista para aqui e espera até você apertar IR.','help.s3.c':'Velocidade até aqui — defina uma km/h própria para o trecho que termina neste ponto (senão, a velocidade global).','help.s3.d':'Remover — apague o ponto.','help.s4.t':'IR encerra qualquer espera antecipadamente','help.s4.a':'Apertar IR retoma a condução imediatamente de qualquer parada — uma espera cronometrada, uma espera até IR ou a chegada — sem aguardar o tempo restante.','help.s5.t':'Edite a qualquer momento','help.s5.a':'Cada ponto pode ser editado a qualquer momento — mover, mudar a espera ou velocidade, ou remover. Editar a rota atrás do motorista mantém a posição atual estável (sem salto).','help.s6.t':'Fim da rota','help.s6.a':'No último ponto o motorista para e continua transmitindo essa posição — o GPS NÃO desliga. Desligar o botão de GPS é a única coisa que para a transmissão. Adicione um novo ponto e aperte IR para mandar o motorista adiante.','help.s7.t':'Velocidade','help.s7.a':'Escolha Caminhada, Corrida ou Bicicleta a qualquer momento, mesmo em movimento. A velocidade de cada modo (m/s) é editada nas Configurações. As velocidades por ponto continuam valendo para o seu trecho.','help.s8.t':'Rótulo de status','help.s8.a':'Parado — estacionado, transmitindo. Dirigindo — em movimento. Aguardando m:ss em B — contagem regressiva. Aguardando IR — parado até você apertar IR. Chegou — alcançou o fim, ainda transmitindo.','help.compat.t':'Compatibilidade','help.compat.a':'Alguns apps de mapas (por exemplo, Yandex Maps) usam o próprio posicionamento por Wi-Fi/rede e podem voltar à sua localização real. Desative o Wi-Fi e os dados móveis durante a simulação para evitar isso.','help.s9.t':'Configuração do telefone','help.s9.a':'O GPS falso precisa que o Route Spoofer esteja selecionado como app de localização fictícia nas opções do desenvolvedor do Android. O cartão de prontidão orienta você.','help.openSetup':'Abrir configurações de localização','help.legGps':'GPS','help.legGo':'IR / Pausar','help.legStop':'Parar','help.mapLeg.t':'Legenda do mapa','help.mapLeg.start':'Início (A)','help.mapLeg.up':'Ponto à frente / editável','help.mapLeg.end':'Ponto final','help.lock.t':'Bloquear rota','help.lock.a':'Toque em Bloquear para proteger a rota de edições acidentais — enquanto bloqueada, toques no mapa e o arraste de pontos são ignorados, então um toque acidental não adiciona nem move pontos. Todo o resto (reprodução, velocidade, repetição…) continua funcionando.','help.lock.b':'Toque de novo para desbloquear e editar os pontos como sempre. As rotas começam desbloqueadas.',
  },
  fr: {
    'state.ready':'Prêt','state.emitting':'Émission','state.paused':'En pause',
    'status.standing':'Arrêté','status.driving':'En route','status.arrived':'Arrivé','status.waitingGo':'En attente de GO','status.waitingAt':'Attente','status.atWp':'à','gps.on':'GPS activé','gps.off':'GPS désactivé','go.go':'GO','go.pause':'Pause','wpm.dwell':'Attendre ici','wpm.none':'Aucune','wpm.minutes':'minutes','wpm.untilGo':"Jusqu'à GO",'wpm.speed':'Vitesse jusqu’ici (km/h)','wpm.remove':'Supprimer','wpm.close':'Fermer',
    'hud.speed':'Vitesse','hud.heading':'Cap','hud.progress':'Progression','hud.distance':'Distance',
    'hint.tapMap':'Touchez la carte pour placer le point A, puis B, puis C…','search.ph':'Rechercher un lieu ou une adresse…','search.searching':'Recherche…','search.notFound':'Aucun lieu trouvé.','search.error':'Échec de la recherche — réessayez.','routes.open':'Routes enregistrées','routes.title':'Routes enregistrées','routes.save':'Enregistrer l\'actuelle','routes.namePrompt':'Nommer cette route :','routes.renamePrompt':'Nouveau nom :','routes.search':'Filtrer les routes…','routes.selectAll':'Tout sélectionner','routes.clearSel':'Effacer','routes.selected':'sélectionnées','routes.rename':'Renommer','routes.delete':'Supprimer','routes.delSelected':'Supprimer la sélection','routes.exportSel':'Exporter la sélection','routes.exportAll':'Tout exporter','routes.import':'Importer','routes.deleteAll':'Tout supprimer','routes.empty':'Aucune route enregistrée.','routes.noMatch':'Aucune route correspondante.','routes.full':'Limite atteinte (50) — supprimez ou exportez d\'abord.','routes.needPoints':'Placez d\'abord au moins un point.','routes.confirmDelete':'Supprimer cette route ?','routes.confirmDelSel':'Supprimer les routes sélectionnées ?','routes.confirmDelAll':'Supprimer TOUTES les routes enregistrées ?','routes.saved':'Route enregistrée.','routes.loaded':'Route chargée.','routes.importBad':'Format de fichier invalide.','routes.importDone':'{a} importées, {b} ignorées.','routes.noneSelected':'Sélectionnez d\'abord des routes.','routes.exported':'Exporté.','routes.exportErr':'Échec de l\'export.','routes.shareTitle':'Partager les routes',
    'live.seg':'seg','live.emit':'émission','live.elapsed':'temps','live.noRoute':'aucun trajet',
    'field.speed':'Vitesse','field.emitEvery':'Émettre toutes les','field.loop':'Boucle','mode.walk':'Marche','mode.run':'Course','mode.bike':'Vélo','settings.title':'Réglages','settings.speedsHint':'Vitesse de chaque mode en mètres par seconde.',
    'loop.off':'Désact.','loop.restart':'Redémarrer','loop.pingpong':'Aller-retour',
    'tool.myLocation':'Ma position','tool.reverse':'Inverser','tool.undo':'Annuler','tool.clear':'Effacer','tool.lock':'Verrouiller','tool.locked':'Verrouillé','map.clearRoute':'Effacer la route','map.clearConfirm':'Effacer tous les points et commencer une nouvelle route ?','locate.timeout':'Impossible d\'obtenir votre position','locate.stopPlayback':'Arrêtez la lecture pour trouver votre position réelle','update.available':'Mise à jour disponible','update.download':'Télécharger','update.downloading':'Téléchargement…','update.later':'Plus tard','update.confirmStop':'L\'installation arrêtera la lecture en cours. Continuer ?','update.allowInstall':'Autorisez l\'installation depuis cette app, puis appuyez à nouveau sur Télécharger.','update.badFile':'Le fichier est corrompu. Réessayez.','update.failed':'Échec de la mise à jour. Réessayez plus tard.',
    'log.summary':'Points émis','log.waiting':'en attente de lecture…',
    'setup.title':'Activer le GPS fictif',
    'setup.intro':'Route Spoofer a besoin de deux choses avant de contrôler la position de l’appareil.',
    'setup.check1title':'Autorisation de localisation et de notifications',
    'setup.check1desc':'Autorisez l’accès pour que le service fonctionne.',
    'setup.check2title':'Sélectionné comme appli de position fictive',
    'setup.check2desc':'Options pour les développeurs → « Application de position fictive » → Route Spoofer.',
    'setup.grant':'Accorder les autorisations','setup.openDev':'Ouvrir les options pour développeurs',
    'setup.recheck':'Revérifier','setup.dismiss':'Ignorer',
    'setup.granted':'Accordée',
    'setup.check2help':'Comment sélectionner l’application de position fictive',
    'setup.pendingPerm':'Il manque encore : accorder l’autorisation de localisation et de notifications.',
    'setup.pendingMock':'Il manque encore : sélectionner Route Spoofer comme application de position fictive dans les options pour développeurs.',
    'setup.stillChecking':'État illisible — appuyez de nouveau sur « Revérifier ».',
    'mock.title':'Sélectionner l’application de position fictive',
    'mock.intro':'Indiquez à Android que Route Spoofer est sa source de position fictive — un réglage unique.',
    'mock.step1':'Activez les options pour développeurs : Paramètres → À propos du téléphone → appuyez 7 fois sur Numéro de build.',
    'mock.step1sub':'Sur Samsung : → Informations sur le logiciel.',
    'mock.step2':'Ouvrez Paramètres → Système → Options pour développeurs.',
    'mock.step3':'Appuyez sur « Sélectionner l’application de position fictive ».',
    'mock.step4':'Choisissez Route Spoofer.',
    'mock.note':'Le chemin exact varie légèrement selon la marque.',
    'mock.pending':'Pas encore sélectionnée — choisissez Route Spoofer dans « Sélectionner l’application de position fictive ».',
    'hint.locationBlocked':'La localisation est bloquée. Dans Paramètres → Autorisations, autorisez la Localisation.',
    'dev.title':'Les options pour développeurs sont désactivées',
    'dev.intro':'Le GPS fictif nécessite les options pour développeurs d’Android activées — un réglage unique. Activez-les puis revérifiez.',
    'dev.step1':'Ouvrez Paramètres → À propos du téléphone','dev.step1sub':'Sur Samsung : → Informations sur le logiciel.',
    'dev.step2':'Touchez « Numéro de build » 7 fois','dev.step3':'Saisissez votre code/mot de passe si demandé',
    'dev.step4':'Revenez ici et touchez « Revérifier »',
    'dev.note':'Le chemin exact varie légèrement selon la marque.',
    'dev.openAbout':'Ouvrir À propos du téléphone','dev.recheck':'Revérifier','dev.close':'Fermer',
    'hint.dropFirst':'Placez d’abord au moins un point.','hint.needTwo':'Ajoutez un deuxième point — GO roule entre les points.','hint.gpsFirst':'Activez d’abord le GPS — touchez le bouton GPS.','hint.routeComplete':'Trajet terminé.',
    'hint.finishSetup':'Terminez la configuration pour démarrer.','hint.couldNotStart':'Impossible de démarrer le service fictif.',
    'hint.locating':'Localisation…','hint.centered':'Centré sur votre position.',
    'hint.locationDenied':'La localisation est désactivée — activez-la dans les Paramètres.','hint.geoUnavailable':'Géolocalisation indisponible.',
    'hint.locationTimeout':'Pas encore de position — réessayez.','hint.centeredMock':'Centré sur la position que vous diffusez.',
    'hint.ready':'Prêt — touchez lecture.','hint.openSettingsManual':'Ouvrez Options pour développeurs → Sélectionner l’application de localisation fictive → choisissez Route Spoofer.','hint.devOn':'Options développeur activées — choisissez l’appli de position fictive.',
    'hint.devStillOff':'Toujours désactivé — activez les options développeur pour continuer.',
    'wp.startRemove':'Départ — touchez pour supprimer','wp.tapRemove':'Touchez pour supprimer',
    'title.play':'Lecture / pause','title.stop':'Arrêter et revenir au départ',
    'about.auto':'Auto','about.github':'Voir sur GitHub','about.qa':'Bêta-testé par',
    'link.openFailCopied':'Impossible d’ouvrir un navigateur. Lien copié : {url}','link.openFail':'Impossible d’ouvrir un navigateur. Ouvrez-le manuellement : {url}',
    'help.title':'Comment ça marche','help.s1.t':'Deux commandes distinctes','help.s1.a':'GPS — active/désactive la diffusion de la position. Quand il est ON, l\'appli envoie votre position à tout l\'appareil (et toute autre appli la lit comme réelle). C\'est indépendant du mouvement.','help.s1.b':'GO / Pause — roule le long de votre trajet. N\'a d\'importance que lorsque le GPS est ON et que vous avez 2+ points.','help.s1.c':'Avec le GPS ON et un seul point, le conducteur reste simplement là et diffuse.','help.s2.t':'Construire un trajet','help.s2.a':'Touchez la carte pour déposer des points (A, B, C…). Faites glisser un point pour le déplacer.','help.s2.b':'En roulant, vous pouvez toucher la carte pour ajouter un nouveau point à la fin du trajet.','help.s3.t':'Options du point (appui long sur un point)','help.s3.a':'Attendre N minutes — le conducteur s\'arrête ici pour la durée définie, puis repart automatiquement.','help.s3.b':'Attendre jusqu\'à GO — le conducteur s\'arrête ici et attend que vous appuyiez sur GO.','help.s3.c':'Vitesse jusqu\'ici — définissez une km/h personnalisée pour le tronçon se terminant à ce point (sinon la vitesse globale).','help.s3.d':'Supprimer — supprimer le point.','help.s4.t':'GO met fin à toute attente par anticipation','help.s4.a':'Appuyer sur GO reprend immédiatement la conduite depuis n\'importe quel arrêt — une attente minutée, une attente jusqu\'à GO ou l\'arrivée — sans attendre le temps restant.','help.s5.t':'Modifier à tout moment','help.s5.a':'Chaque point peut être modifié à tout moment — le déplacer, changer son attente ou sa vitesse, ou le supprimer. Modifier le trajet derrière le conducteur garde la position actuelle stable (sans saut).','help.s6.t':'Fin du trajet','help.s6.a':'Au dernier point, le conducteur s\'arrête et continue de diffuser cette position — le GPS ne s\'éteint PAS. Désactiver le bouton GPS est la seule chose qui arrête la diffusion. Ajoutez un nouveau point et appuyez sur GO pour envoyer le conducteur plus loin.','help.s7.t':'Vitesse','help.s7.a':'Choisissez Marche, Course ou Vélo à tout moment, même en roulant. La vitesse de chaque mode (m/s) se règle dans les Réglages. Les vitesses par point s\'appliquent toujours à leur tronçon.','help.s8.t':'Étiquette d\'état','help.s8.a':'Arrêté — stationné, diffuse. En route — en mouvement. Attente m:ss à B — décompte minuté. En attente de GO — arrêté jusqu\'à ce que vous appuyiez sur GO. Arrivé — fin atteinte, diffuse encore.','help.compat.t':'Compatibilité','help.compat.a':'Certaines applis de cartes (p. ex. Yandex Maps) utilisent leur propre positionnement Wi-Fi/réseau et peuvent revenir à votre position réelle. Désactivez le Wi-Fi et les données mobiles pendant la simulation pour l\'éviter.','help.s9.t':'Configuration du téléphone','help.s9.a':'Le GPS fictif nécessite que Route Spoofer soit sélectionnée comme appli de position fictive dans les options pour développeurs d\'Android. La carte de disponibilité vous guide.','help.openSetup':'Ouvrir les paramètres de localisation','help.legGps':'GPS','help.legGo':'GO / Pause','help.legStop':'Arrêt','help.mapLeg.t':'Légende de la carte','help.mapLeg.start':'Départ (A)','help.mapLeg.up':'Point à venir / modifiable','help.mapLeg.end':'Point final','help.lock.t':'Verrouiller le trajet','help.lock.a':'Touchez Verrouiller pour protéger le trajet des modifications accidentelles — une fois verrouillé, les touchers sur la carte et le glissement des points sont ignorés, de sorte qu\'un toucher involontaire ne peut pas ajouter ni déplacer de points. Tout le reste (lecture, vitesse, boucle…) continue de fonctionner.','help.lock.b':'Touchez de nouveau pour déverrouiller et modifier les points comme d\'habitude. Les trajets démarrent déverrouillés.',
  },
  zh: {
    'state.ready':'就绪','state.emitting':'发送中','state.paused':'已暂停',
    'status.standing':'停止','status.driving':'行驶中','status.arrived':'已到达','status.waitingGo':'等待 GO','status.waitingAt':'等待','status.atWp':'于','gps.on':'GPS 开','gps.off':'GPS 关','go.go':'出发','go.pause':'暂停','wpm.dwell':'在此等待','wpm.none':'无','wpm.minutes':'分钟','wpm.untilGo':'直到 GO','wpm.speed':'到此速度 (km/h)','wpm.remove':'删除','wpm.close':'关闭',
    'hud.speed':'速度','hud.heading':'航向','hud.progress':'进度','hud.distance':'距离',
    'hint.tapMap':'点击地图放置点 A，然后 B、C…','search.ph':'搜索地点或地址…','search.searching':'搜索中…','search.notFound':'未找到地点。','search.error':'搜索失败，请重试。','routes.open':'已保存的路线','routes.title':'已保存的路线','routes.save':'保存当前','routes.namePrompt':'为此路线命名：','routes.renamePrompt':'新名称：','routes.search':'筛选路线…','routes.selectAll':'全选','routes.clearSel':'清除','routes.selected':'已选','routes.rename':'重命名','routes.delete':'删除','routes.delSelected':'删除所选','routes.exportSel':'导出所选','routes.exportAll':'导出全部','routes.import':'导入','routes.deleteAll':'全部删除','routes.empty':'还没有保存的路线。','routes.noMatch':'没有匹配的路线。','routes.full':'已达上限（50）——请先删除或导出一些。','routes.needPoints':'请先添加至少一个点。','routes.confirmDelete':'删除此路线？','routes.confirmDelSel':'删除所选路线？','routes.confirmDelAll':'删除全部已保存的路线？','routes.saved':'路线已保存。','routes.loaded':'路线已加载。','routes.importBad':'文件格式无效。','routes.importDone':'已导入 {a}，跳过 {b}。','routes.noneSelected':'请先选择一些路线。','routes.exported':'已导出。','routes.exportErr':'导出失败。','routes.shareTitle':'分享路线',
    'live.seg':'段','live.emit':'发送','live.elapsed':'用时','live.noRoute':'无路线',
    'field.speed':'速度','field.emitEvery':'发送间隔','field.loop':'循环','mode.walk':'步行','mode.run':'跑步','mode.bike':'骑行','settings.title':'设置','settings.speedsHint':'每种模式的速度，单位米/秒。',
    'loop.off':'关','loop.restart':'重新开始','loop.pingpong':'往返',
    'tool.myLocation':'我的位置','tool.reverse':'反向','tool.undo':'撤销','tool.clear':'清除','tool.lock':'锁定','tool.locked':'已锁定','map.clearRoute':'清除路线','map.clearConfirm':'清除所有点并开始新路线？','locate.timeout':'无法获取你的位置','locate.stopPlayback':'请先停止播放，再查找你的真实位置','update.available':'有可用更新','update.download':'下载','update.downloading':'正在下载…','update.later':'稍后','update.confirmStop':'安装会停止当前播放，是否继续？','update.allowInstall':'请允许本应用安装应用，然后再次点击下载。','update.badFile':'安装包校验失败，请重试。','update.failed':'更新失败，请稍后再试。',
    'log.summary':'已发送的点','log.waiting':'等待播放…',
    'setup.title':'启用模拟 GPS',
    'setup.intro':'Route Spoofer 需要两项设置才能控制设备位置。',
    'setup.check1title':'位置和通知权限',
    'setup.check1desc':'请允许访问，以便服务运行。',
    'setup.check2title':'已选为模拟位置应用',
    'setup.check2desc':'开发者选项 →“选择模拟位置应用”→ Route Spoofer。',
    'setup.grant':'授予权限','setup.openDev':'打开开发者选项',
    'setup.recheck':'重新检查','setup.dismiss':'忽略',
    'setup.granted':'已授予',
    'setup.check2help':'如何选择模拟位置应用',
    'setup.pendingPerm':'仍需完成：授予位置和通知权限。',
    'setup.pendingMock':'仍需完成：在开发者选项中将 Route Spoofer 选为模拟位置应用。',
    'setup.stillChecking':'无法读取状态——请再次点击“重新检查”。',
    'mock.title':'选择模拟位置应用',
    'mock.intro':'将 Route Spoofer 设为 Android 的模拟位置来源——这是一次性设置。',
    'mock.step1':'启用开发者选项：设置 → 关于手机 → 连续点击“版本号”7 次。',
    'mock.step1sub':'三星机型：→ 软件信息。',
    'mock.step2':'打开 设置 → 系统 → 开发者选项。',
    'mock.step3':'点击“选择模拟位置应用”。',
    'mock.step4':'选择 Route Spoofer。',
    'mock.note':'具体路径因手机品牌略有不同。',
    'mock.pending':'尚未选择——请在“选择模拟位置应用”中选择 Route Spoofer。',
    'hint.locationBlocked':'位置权限被屏蔽。请在 设置 → 权限 中允许“位置”。',
    'dev.title':'开发者选项未开启',
    'dev.intro':'模拟 GPS 需要开启 Android 开发者选项，这是一次性设置。开启后返回并重新检查。',
    'dev.step1':'打开 设置 → 关于手机','dev.step1sub':'三星机型：→ 软件信息。',
    'dev.step2':'连续点击“版本号”7 次','dev.step3':'如有提示，请输入 PIN 码或密码',
    'dev.step4':'返回此处并点击“重新检查”',
    'dev.note':'具体路径因手机品牌略有不同。',
    'dev.openAbout':'打开“关于手机”','dev.recheck':'重新检查','dev.close':'关闭',
    'hint.dropFirst':'请先放置至少一个点。','hint.needTwo':'再加一个点——GO 在点之间行驶。','hint.gpsFirst':'请先打开 GPS——点击 GPS 按钮。','hint.routeComplete':'路线完成。',
    'hint.finishSetup':'完成设置后即可开始。','hint.couldNotStart':'无法启动模拟服务。',
    'hint.locating':'定位中…','hint.centered':'已居中到你的位置。',
    'hint.locationDenied':'位置已关闭——请在设置中允许。','hint.geoUnavailable':'无法使用定位。',
    'hint.locationTimeout':'尚未获取到定位——请重试。','hint.centeredMock':'已居中到你正在广播的位置。',
    'hint.ready':'就绪 — 点击播放。','hint.openSettingsManual':'打开开发者选项 → 选择模拟位置信息应用 → 选择 Route Spoofer。','hint.devOn':'开发者选项已开启 — 现在选择模拟位置应用。',
    'hint.devStillOff':'仍未开启 — 请开启开发者选项以继续。',
    'wp.startRemove':'起点 — 点击删除','wp.tapRemove':'点击删除',
    'title.play':'播放 / 暂停','title.stop':'停止并重置到起点',
    'about.auto':'自动','about.github':'在 GitHub 查看','about.qa':'Beta 测试：',
    'link.openFailCopied':'无法打开浏览器。链接已复制：{url}','link.openFail':'无法打开浏览器。请手动打开：{url}',
    'help.title':'工作原理','help.s1.t':'两个独立控制','help.s1.a':'GPS——开启/关闭位置广播。开启时，应用会把你的位置提供给整部设备（其他任何应用都会当作真实位置读取）。这与移动无关。','help.s1.b':'出发 / 暂停——沿你的路线行驶。仅在 GPS 开启且有 2 个以上的点时才有意义。','help.s1.c':'GPS 开启且只有一个点时，司机就停在那里广播。','help.s2.t':'构建路线','help.s2.a':'点击地图放置点（A、B、C…）。拖动点可移动它。','help.s2.b':'行驶时你可以点击地图，将新点追加到路线末尾。','help.s3.t':'点的选项（长按一个点）','help.s3.a':'等待 N 分钟——司机在此停留设定的时间，然后自动继续行驶。','help.s3.b':'等到出发——司机在此停下，等待你按下出发。','help.s3.c':'到此速度——为以此点结束的路段设置自定义 km/h（否则使用全局速度）。','help.s3.d':'删除——删除该点。','help.s4.t':'出发可提前结束任何等待','help.s4.a':'按下出发会立即从任何停留处恢复行驶——定时等待、等到出发或到达——无需等待剩余时间。','help.s5.t':'随时编辑','help.s5.a':'每个点都可以随时编辑——移动、修改其等待或速度，或删除。编辑司机后方的路线会保持当前位置稳定（不跳变）。','help.s6.t':'路线终点','help.s6.a':'在最后一个点，司机停下并继续广播该位置——GPS 不会关闭。关闭 GPS 开关是唯一能停止广播的方式。添加新点并按下出发，即可让司机继续前进。','help.s7.t':'速度','help.s7.a':'随时在控制面板选择步行、跑步或骑行（行驶中也可切换），实时改变速度。每种模式的速度（米/秒）可在设置里修改。为某个点单独设置的速度仍作用于该路段。','help.s8.t':'状态标签','help.s8.a':'停止——已停放，正在广播。行驶中——正在移动。等待 m:ss 于 B——定时倒计时。等待出发——停下直到你按下出发。已到达——到达终点，仍在广播。','help.compat.t':'兼容性','help.compat.a':'某些地图应用（例如 Yandex 地图）使用自己的 Wi-Fi/网络定位，可能会跳回你的真实位置。模拟时请关闭 Wi-Fi 和移动数据以避免此问题。','help.s9.t':'手机设置','help.s9.a':'模拟 GPS 需要在 Android 开发者选项中将 Route Spoofer 选为模拟位置应用。就绪卡片会引导你完成。','help.openSetup':'打开位置设置','help.legGps':'GPS','help.legGo':'出发 / 暂停','help.legStop':'停止','help.mapLeg.t':'地图图例','help.mapLeg.start':'起点 (A)','help.mapLeg.up':'即将到达 / 可编辑的点','help.mapLeg.end':'终点','help.lock.t':'锁定路线','help.lock.a':'点击锁定可保护路线免受误编辑——锁定后，地图点击和拖动点都会被忽略，因此误触不会添加或移动点。其他功能（行驶、速度、循环…）照常工作。','help.lock.b':'再次点击即可解锁并照常编辑点。路线默认处于解锁状态。',
  },
  hi: {
    'state.ready':'तैयार','state.emitting':'भेज रहा है','state.paused':'रुका हुआ',
    'status.standing':'खड़ा','status.driving':'चल रहा है','status.arrived':'पहुँच गया','status.waitingGo':'GO का इंतज़ार','status.waitingAt':'इंतज़ार','status.atWp':'पर','gps.on':'GPS चालू','gps.off':'GPS बंद','go.go':'चलें','go.pause':'रोकें','wpm.dwell':'यहाँ रुकें','wpm.none':'कोई नहीं','wpm.minutes':'मिनट','wpm.untilGo':'GO तक','wpm.speed':'यहाँ तक गति (km/h)','wpm.remove':'हटाएँ','wpm.close':'बंद करें',
    'hud.speed':'गति','hud.heading':'दिशा','hud.progress':'प्रगति','hud.distance':'दूरी',
    'hint.tapMap':'बिंदु A, फिर B, फिर C रखने के लिए मानचित्र पर टैप करें…','search.ph':'कोई स्थान या पता खोजें…','search.searching':'खोज रहे हैं…','search.notFound':'कोई स्थान नहीं मिला।','search.error':'खोज विफल — फिर से प्रयास करें।','routes.open':'सहेजे गए रूट','routes.title':'सहेजे गए रूट','routes.save':'वर्तमान सहेजें','routes.namePrompt':'इस रूट का नाम दें:','routes.renamePrompt':'नया नाम:','routes.search':'रूट फ़िल्टर करें…','routes.selectAll':'सभी चुनें','routes.clearSel':'साफ़ करें','routes.selected':'चयनित','routes.rename':'नाम बदलें','routes.delete':'हटाएँ','routes.delSelected':'चयनित हटाएँ','routes.exportSel':'चयनित निर्यात करें','routes.exportAll':'सभी निर्यात करें','routes.import':'आयात करें','routes.deleteAll':'सभी हटाएँ','routes.empty':'अभी तक कोई सहेजा गया रूट नहीं।','routes.noMatch':'कोई रूट मेल नहीं खाता।','routes.full':'सीमा पूरी (50) — पहले कुछ हटाएँ या निर्यात करें।','routes.needPoints':'पहले कम से कम एक बिंदु जोड़ें।','routes.confirmDelete':'यह रूट हटाएँ?','routes.confirmDelSel':'चयनित रूट हटाएँ?','routes.confirmDelAll':'सभी सहेजे गए रूट हटाएँ?','routes.saved':'रूट सहेजा गया।','routes.loaded':'रूट लोड हुआ।','routes.importBad':'फ़ाइल का प्रारूप अमान्य है।','routes.importDone':'{a} आयात किए, {b} छोड़े।','routes.noneSelected':'पहले कुछ रूट चुनें।','routes.exported':'निर्यात हो गया।','routes.exportErr':'निर्यात विफल।','routes.shareTitle':'रूट साझा करें',
    'live.seg':'सेग','live.emit':'भेजना','live.elapsed':'समय','live.noRoute':'कोई रूट नहीं',
    'field.speed':'गति','field.emitEvery':'हर बार भेजें','field.loop':'लूप','mode.walk':'चलना','mode.run':'दौड़ना','mode.bike':'साइकिल','settings.title':'सेटिंग्स','settings.speedsHint':'हर मोड की गति, मीटर प्रति सेकंड।',
    'loop.off':'बंद','loop.restart':'फिर से शुरू','loop.pingpong':'आगे-पीछे',
    'tool.myLocation':'मेरा स्थान','tool.reverse':'उल्टा','tool.undo':'पूर्ववत्','tool.clear':'साफ़ करें','tool.lock':'लॉक करें','tool.locked':'लॉक किया','map.clearRoute':'रूट साफ़ करें','map.clearConfirm':'सभी बिंदु हटाकर नया रूट शुरू करें?','locate.timeout':'आपका स्थान नहीं मिल सका','locate.stopPlayback':'अपना असली स्थान देखने के लिए प्लेबैक रोकें','update.available':'अपडेट उपलब्ध','update.download':'डाउनलोड','update.downloading':'डाउनलोड हो रहा है…','update.later':'बाद में','update.confirmStop':'इंस्टॉल करने पर मौजूदा प्लेबैक रुक जाएगा। जारी रखें?','update.allowInstall':'इस ऐप से इंस्टॉल की अनुमति दें, फिर दोबारा डाउनलोड दबाएँ।','update.badFile':'फ़ाइल खराब है। फिर कोशिश करें।','update.failed':'अपडेट विफल। बाद में फिर कोशिश करें।',
    'log.summary':'भेजे गए बिंदु','log.waiting':'प्लेबैक की प्रतीक्षा…',
    'setup.title':'मॉक GPS चालू करें',
    'setup.intro':'डिवाइस का स्थान नियंत्रित करने से पहले Route Spoofer को दो चीज़ें चाहिए।',
    'setup.check1title':'स्थान और सूचना अनुमति',
    'setup.check1desc':'सेवा चलाने के लिए पहुँच की अनुमति दें।',
    'setup.check2title':'मॉक स्थान ऐप के रूप में चुना गया',
    'setup.check2desc':'डेवलपर विकल्प → «मॉक स्थान ऐप चुनें» → Route Spoofer।',
    'setup.grant':'अनुमतियाँ दें','setup.openDev':'डेवलपर विकल्प खोलें',
    'setup.recheck':'फिर से जाँचें','setup.dismiss':'खारिज करें',
    'setup.granted':'दी गई',
    'setup.check2help':'मॉक लोकेशन ऐप कैसे चुनें',
    'setup.pendingPerm':'अभी बाकी: स्थान और सूचना की अनुमति दें।',
    'setup.pendingMock':'अभी बाकी: डेवलपर विकल्पों में Route Spoofer को मॉक लोकेशन ऐप के रूप में चुनें।',
    'setup.stillChecking':'स्थिति नहीं पढ़ी जा सकी — फिर से «फिर से जाँचें» दबाएँ।',
    'mock.title':'मॉक लोकेशन ऐप चुनें',
    'mock.intro':'Android को बताएँ कि Route Spoofer उसका मॉक लोकेशन स्रोत है — यह एक बार की सेटिंग है।',
    'mock.step1':'डेवलपर विकल्प चालू करें: सेटिंग्स → फ़ोन के बारे में → «बिल्ड नंबर» पर 7 बार टैप करें।',
    'mock.step1sub':'Samsung पर: → सॉफ़्टवेयर जानकारी।',
    'mock.step2':'सेटिंग्स → सिस्टम → डेवलपर विकल्प खोलें।',
    'mock.step3':'«मॉक लोकेशन ऐप चुनें» पर टैप करें।',
    'mock.step4':'Route Spoofer चुनें।',
    'mock.note':'सटीक रास्ता फ़ोन ब्रांड के अनुसार थोड़ा अलग होता है।',
    'mock.pending':'अभी चुना नहीं गया — «मॉक लोकेशन ऐप चुनें» में Route Spoofer चुनें।',
    'hint.locationBlocked':'स्थान अवरुद्ध है। सेटिंग्स → अनुमतियाँ में «स्थान» की अनुमति दें।',
    'dev.title':'डेवलपर विकल्प बंद हैं',
    'dev.intro':'मॉक GPS के लिए Android के डेवलपर विकल्प चालू होने चाहिए — यह एक बार की सेटिंग है। इसे चालू करें और फिर से जाँचें।',
    'dev.step1':'सेटिंग → फ़ोन के बारे में खोलें','dev.step1sub':'Samsung पर: → सॉफ़्टवेयर जानकारी।',
    'dev.step2':'«बिल्ड नंबर» पर 7 बार टैप करें','dev.step3':'पूछे जाने पर अपना PIN/पासवर्ड डालें',
    'dev.step4':'यहाँ लौटें और «फिर से जाँचें» पर टैप करें',
    'dev.note':'सटीक रास्ता फ़ोन ब्रांड के अनुसार थोड़ा अलग होता है।',
    'dev.openAbout':'फ़ोन के बारे में खोलें','dev.recheck':'फिर से जाँचें','dev.close':'बंद करें',
    'hint.dropFirst':'पहले कम से कम एक बिंदु रखें।','hint.needTwo':'दूसरा बिंदु जोड़ें — GO बिंदुओं के बीच चलाता है।','hint.gpsFirst':'पहले GPS चालू करें — GPS बटन दबाएँ।','hint.routeComplete':'रूट पूरा हुआ।',
    'hint.finishSetup':'शुरू करने के लिए सेटअप पूरा करें।','hint.couldNotStart':'मॉक सेवा शुरू नहीं हो सकी।',
    'hint.locating':'ढूँढ रहा है…','hint.centered':'आपके स्थान पर केंद्रित।',
    'hint.locationDenied':'स्थान बंद है — इसे सेटिंग्स में चालू करें।','hint.geoUnavailable':'जियोलोकेशन उपलब्ध नहीं।',
    'hint.locationTimeout':'अभी स्थान नहीं मिला — फिर से कोशिश करें।','hint.centeredMock':'आप जो स्थान भेज रहे हैं, मानचित्र उस पर केंद्रित है।',
    'hint.ready':'तैयार — प्ले पर टैप करें।','hint.openSettingsManual':'डेवलपर विकल्प → मॉक लोकेशन ऐप चुनें → Route Spoofer चुनें।','hint.devOn':'डेवलपर विकल्प चालू — अब मॉक स्थान ऐप चुनें।',
    'hint.devStillOff':'अब भी बंद — जारी रखने के लिए डेवलपर विकल्प चालू करें।',
    'wp.startRemove':'शुरुआत — हटाने के लिए टैप करें','wp.tapRemove':'हटाने के लिए टैप करें',
    'title.play':'प्ले / पॉज़','title.stop':'रोकें और शुरुआत पर रीसेट करें',
    'about.auto':'स्वतः','about.github':'GitHub पर देखें','about.qa':'बीटा-परीक्षण:',
    'link.openFailCopied':'ब्राउज़र नहीं खुल सका। लिंक कॉपी किया गया: {url}','link.openFail':'ब्राउज़र नहीं खुल सका। इसे मैन्युअल रूप से खोलें: {url}',
    'help.title':'यह कैसे काम करता है','help.s1.t':'दो अलग-अलग नियंत्रण','help.s1.a':'GPS — लोकेशन प्रसारण चालू/बंद करता है। चालू होने पर ऐप आपकी स्थिति पूरे डिवाइस को देता है (और कोई भी अन्य ऐप उसे असली मानकर पढ़ता है)। यह चलने से स्वतंत्र है।','help.s1.b':'चलें / रोकें — आपके रूट पर चलाता है। केवल तभी मायने रखता है जब GPS चालू हो और आपके पास 2+ बिंदु हों।','help.s1.c':'GPS चालू और केवल एक बिंदु पर, ड्राइवर बस वहीं खड़ा रहकर प्रसारण करता है।','help.s2.t':'रूट बनाना','help.s2.a':'बिंदु (A, B, C…) रखने के लिए मानचित्र पर टैप करें। बिंदु को हिलाने के लिए खींचें।','help.s2.b':'चलते समय आप मानचित्र पर टैप करके रूट के अंत में नया बिंदु जोड़ सकते हैं।','help.s3.t':'बिंदु विकल्प (बिंदु को देर तक दबाएँ)','help.s3.a':'N मिनट रुकें — ड्राइवर यहाँ तय समय तक रुकता है, फिर अपने आप आगे चल पड़ता है।','help.s3.b':'चलें तक रुकें — ड्राइवर यहाँ रुकता है और तब तक इंतज़ार करता है जब तक आप चलें न दबाएँ।','help.s3.c':'यहाँ तक गति — इस बिंदु पर समाप्त होने वाले चरण के लिए अपनी km/h तय करें (अन्यथा वैश्विक गति)।','help.s3.d':'हटाएँ — बिंदु हटाएँ।','help.s4.t':'चलें किसी भी इंतज़ार को जल्दी समाप्त करता है','help.s4.a':'चलें दबाने से किसी भी ठहराव — समयबद्ध इंतज़ार, चलें तक इंतज़ार, या पहुँचने — से ड्राइविंग तुरंत फिर शुरू हो जाती है, बचा हुआ समय पूरा किए बिना।','help.s5.t':'कभी भी संपादित करें','help.s5.a':'हर बिंदु को कभी भी संपादित किया जा सकता है — हिलाएँ, उसका इंतज़ार या गति बदलें, या हटाएँ। ड्राइवर के पीछे रूट संपादित करने पर वर्तमान स्थिति स्थिर रहती है (कोई छलांग नहीं)।','help.s6.t':'रूट का अंत','help.s6.a':'अंतिम बिंदु पर ड्राइवर रुकता है और उस स्थिति का प्रसारण जारी रखता है — GPS बंद नहीं होता। GPS टॉगल को बंद करना ही प्रसारण रोकने का एकमात्र तरीका है। नया बिंदु जोड़ें और ड्राइवर को आगे भेजने के लिए चलें दबाएँ।','help.s7.t':'गति','help.s7.a':'किसी भी समय, चलते हुए भी, पैनल पर चलना, दौड़ना या साइकिल चुनें और रफ़्तार तुरंत बदलें। हर मोड की गति (m/s) सेटिंग्स में बदली जा सकती है। प्रति-बिंदु गति उनके चरण पर लागू रहती है।','help.s8.t':'स्थिति लेबल','help.s8.a':'खड़ा — रुका हुआ, प्रसारण कर रहा है। चल रहा है — गति में। इंतज़ार m:ss पर B — समयबद्ध उलटी गिनती। चलें का इंतज़ार — रुका हुआ जब तक आप चलें न दबाएँ। पहुँच गया — अंत तक पहुँचा, फिर भी प्रसारण कर रहा है।','help.compat.t':'संगतता','help.compat.a':'कुछ मैप ऐप (जैसे Yandex Maps) अपनी खुद की Wi-Fi/नेटवर्क पोज़िशनिंग का उपयोग करते हैं और आपकी असली लोकेशन पर वापस जा सकते हैं। इससे बचने के लिए स्पूफ़िंग के दौरान Wi-Fi और मोबाइल डेटा बंद कर दें।','help.s9.t':'फ़ोन सेटअप','help.s9.a':'मॉक GPS के लिए ज़रूरी है कि Route Spoofer को Android डेवलपर विकल्प में मॉक लोकेशन ऐप के रूप में चुना जाए। तैयारी कार्ड आपको इसमें मार्गदर्शन देता है।','help.openSetup':'स्थान सेटिंग खोलें','help.legGps':'GPS','help.legGo':'चलें / रोकें','help.legStop':'रोकें','help.mapLeg.t':'मानचित्र की कुंजी','help.mapLeg.start':'शुरुआत (A)','help.mapLeg.up':'आगामी / संपादन योग्य बिंदु','help.mapLeg.end':'अंतिम बिंदु','help.lock.t':'रूट लॉक करें','help.lock.a':'गलती से होने वाले संपादन से रूट को बचाने के लिए लॉक पर टैप करें — लॉक रहने पर मानचित्र टैप और बिंदु खींचना अनदेखा कर दिए जाते हैं, इसलिए गलती से किया गया टैप बिंदु नहीं जोड़ या हिला सकता। बाकी सब (चलाना, गति, लूप…) काम करता रहता है।','help.lock.b':'सामान्य रूप से बिंदु संपादित करने के लिए फिर से टैप करके अनलॉक करें। रूट शुरू में अनलॉक रहते हैं।',
  },
};

let curLang = 'en';
function mapLang(raw){
  if(!raw) return null;
  const l = String(raw).toLowerCase();
  if(l.startsWith('ru')) return 'ru';
  if(l.startsWith('de')) return 'de';
  if(l.startsWith('es')) return 'es';
  if(l.startsWith('pt')) return 'pt';
  if(l.startsWith('fr')) return 'fr';
  if(l.startsWith('zh')) return 'zh';   // zh-CN / zh-Hans / zh-*
  if(l.startsWith('hi')) return 'hi';
  if(l.startsWith('en')) return 'en';
  return null;
}
function detectLang(){
  const cands = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language||'en'];
  for(const c of cands){ const code = mapLang(c); if(code) return code; }
  return 'en';
}
function storedLangPref(){ try{ return localStorage.getItem('routeSpooferLang'); }catch(e){ return null; } }
function t(key){
  const tbl = I18N[curLang] || I18N.en;
  if(key in tbl) return tbl[key];
  if(key in I18N.en) return I18N.en[key];
  return key;
}
function applyI18n(){
  document.querySelectorAll('[data-i18n]').forEach(el=>{ el.textContent = t(el.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-title]').forEach(el=>{ el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el=>{ el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
  document.querySelectorAll('[data-i18n-aria]').forEach(el=>{ el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
  // dynamic bits that aren't plain static text nodes
  $('stateLabel').textContent = statusText();
  renderLiveCoord(S.waypoints.length ? sampleAt(S.traveled) : null);
  if(S.waypoints.length) refreshMarkers();              // rebind localized tooltips
  if(!S.waypoints.length && $('hint').style.opacity==='1') showHint();
  const sel=$('langSel'); if(sel){ const p=storedLangPref(); sel.value = (p && I18N[p]) ? p : 'auto'; }
  const rt=document.getElementById('routes'); if(rt && rt.classList.contains('show')) renderRoutesList();   // re-translate the open routes modal
  if(lastReady) paintReady(lastReady);   // re-apply state-driven button labels/variants after re-translate
  syncLock();                            // lock toggle label/icon switch by state, not a plain data-i18n node
  syncLoopUI();                          // same: the loop surfaces are state-driven, not static text nodes
  updateChipFade();                      // localized labels change chip widths → re-evaluate the scroll fade
  if(updInfo) showUpdateBanner();        // re-apply the version suffix after a language switch
}
function initLang(){
  const pref = storedLangPref();
  curLang = (pref && I18N[pref]) ? pref : detectLang();
  document.documentElement.lang = curLang;
}
function setLang(code){            // explicit user choice ('auto' resolves live)
  if(code==='auto'){ try{ localStorage.removeItem('routeSpooferLang'); }catch(e){} curLang = detectLang(); }
  else { try{ localStorage.setItem('routeSpooferLang', code); }catch(e){} curLang = I18N[code] ? code : 'en'; }
  document.documentElement.lang = curLang;
  applyI18n();
}
async function copyToClipboard(text){
  try{ if(navigator.clipboard && navigator.clipboard.writeText){ await navigator.clipboard.writeText(text); return true; } }
  catch(e){ console.warn('clipboard API failed',e); }
  try{                                   // legacy fallback (older WebViews / no async clipboard)
    const ta=document.createElement('textarea'); ta.value=text;
    ta.setAttribute('readonly',''); ta.style.position='fixed'; ta.style.top='-9999px';
    document.body.appendChild(ta); ta.select();
    const ok=document.execCommand('copy'); document.body.removeChild(ta); return ok;
  }catch(e){ console.warn('execCommand copy failed',e); return false; }
}
// Never throws and never a dead tap (#4520): tries each opener in order, only ever
// returns true on a CONFIRMED open, and otherwise degrades to copy + a visible hint.
async function openExternal(url){
  try{
    if(isNative){
      // (a) PRIMARY — Custom Tab (@capacitor/browser). An in-app browser tab that does
      //     NOT depend on a user-set default browser, so it survives the ColorOS/Android 10
      //     implicit-ACTION_VIEW suppression that used to silently dead-tap this button.
      if(Browser && Browser.open){
        try{ await Browser.open({ url }); return true; }
        catch(e){ console.warn('Browser.open failed',e); }
      }
      // (b) Native ACTION_VIEW — now reports opened:true ONLY when a handler resolved AND
      //     the launch was actually issued (no false positive on silent suppression).
      if(FakeGps && FakeGps.openUrl){
        try{ const r=await FakeGps.openUrl({ url }); if(r && r.opened) return true; }
        catch(e){ console.warn('native openUrl failed',e); }
      }
      // (c) Android share sheet (@capacitor/share) — resolves on virtually any device,
      //     incl. ColorOS. Completing it counts as a successful open.
      if(Share && Share.share){
        try{ await Share.share({ url, title:t('about.github'), text:url }); return true; }
        catch(e){ console.warn('share dismissed/failed',e); }   // fall through to copy+hint
      }
    } else {
      // Web / desktop preview.
      try{ const w=window.open(url, '_blank', 'noopener'); if(w) return true; }
      catch(e){ console.warn('window.open failed',e); }
      try{ location.href=url; return true; }
      catch(e){ console.warn('location.href failed',e); }
    }
  }catch(e){ console.warn('openExternal failed',e); }
  // (d) Terminal fallback — copy the URL and show a clearly visible message. The hint
  //     renders above the deck (raised z-index from #4535), so the user always sees it.
  const copied=await copyToClipboard(url);
  flashHint(t(copied ? 'link.openFailCopied' : 'link.openFail').replace('{url}', url));
  return false;
}
function openGithub(){ return openExternal(GITHUB_URL); }

/* ---------- map ----------
   initMap() is called once at boot. It loads exactly one mapping library
   (AMap JS SDK if MAP_AMAP_JS_KEY is set, otherwise Leaflet), wires up the
   basemap + coordinate helpers + event listeners, and resolves `mapReady`. */
const DEFAULT_CENTER = [39.9087, 116.3975];   // default startup centre (Tiananmen — AMap has no overseas detail)
let map = null;                                // assigned inside initMap()
const mapReady = new Promise(res => { window.addEventListener('DOMContentLoaded', () => initMap().then(res)); });

/* ---------- async library loader ----------
   injects one <script> tag, waits for the global to appear, returns it.
   On failure we always finish with Leaflet — the tile fallback chain there
   is mature and fully functional without a key. */
function _loadScript(url, globalName){
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url; s.async = false; s.defer = false;
    s.onerror = () => reject(new Error('script load failed: ' + url));
    const start = Date.now();
    s.onload = () => {
      const tick = () => {
        if(window[globalName]) resolve(window[globalName]);
        else if(Date.now() - start > 8000) reject(new Error(globalName + ' not loaded'));
        else setTimeout(tick, 30);
      };
      tick();
    };
    document.head.appendChild(s);
  });
}

async function initMap(){
  try{
    if(USING_AMAP){
      try{ await _loadScript(AMAP_JS_SDK_URL, 'AMap'); await _initAmap(); }
      catch(e){
        console.warn('[map] AMap SDK failed, falling back to Leaflet', e);
        await _loadLeaflet();
      }
    } else {
      await _loadLeaflet();
    }
    // coordinate helpers are now branch-aware
    if(USING_AMAP && window.AMap){
      toMapLL = (lat,lng) => {
        const r = AMap.convertFrom([lng, lat], 'gps');
        return r ? [r.lat, r.lng] : GCJ.wgs2gcj(lat,lng);   // fall back if SDK fails
      };
      fromMapLL = ll => {
        const r = AMap.convertTo([ll.lng, ll.lat], 'gps');
        if(r) return { lat: r.lat, lng: r.lng };
        const w = GCJ.gcj2wgs(ll.lat, ll.lng);
        return { lat: w[0], lng: w[1] };
      };
    } else {
      toMapLL = (lat,lng) => { const g=GCJ.wgs2gcj(lat,lng); return [g[0],g[1]]; };
      fromMapLL = ll => { const w=GCJ.gcj2wgs(ll.lat,ll.lng); return { lat:w[0], lng:w[1] }; };
    }
    centerOnMap(DEFAULT_CENTER, 13, false);
    console.info('[map] library:', USING_AMAP ? 'AMap JS SDK' : 'Leaflet');
  }catch(e){ console.error('[map] init failed', e); }
}

async function _loadLeaflet(){
  await _loadScript('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js', 'L');
  map = L.map('map', { zoomControl:false, attributionControl:true });
  map.attributionControl.setPrefix(false);
  // basemap install (AMap raster → OSM fallback, unchanged)
  let basemap = null;
  function useOsmBasemap(){
    basemap = L.tileLayer(MAP_RASTER_URL, Object.assign({ attribution: MAP_RASTER_ATTRIBUTION }, MAP_RASTER_OPTS)).addTo(map);
    console.info('[map] basemap: OSM raster (fallback)');
  }
  function installBasemap(){
    let loaded=0, failed=0;
    const layer=L.tileLayer(AMAP_TILE_URL, AMAP_TILE_OPTS);
    layer.on('tileload',()=>{ loaded++; });
    layer.on('tileerror',()=>{
      if(loaded>0 || basemap!==layer) return;
      if(++failed<6) return;
      console.warn('[map] AMap tiles unavailable, falling back to OSM');
      try{ map.removeLayer(layer); }catch(e){}
      useOsmBasemap();
    });
    layer.addTo(map); basemap=layer;
    console.info('[map] basemap: AMap raster');
  }
  map.whenReady(installBasemap);
  // Leaflet-specific events (click set up later via _setupMapClickHandlers to satisfy definition order)
  map.on('moveend', _onMoveEndLeaflet);
}

async function _initAmap(){
  // AMap.Map creates the basemap automatically — no tile layer management needed.
  map = new AMap.Map('map', {
    zoom: 13,
    center: [DEFAULT_CENTER[1], DEFAULT_CENTER[0]],
    viewMode: '2D',
    features: ['bg','road','building','point'],
    showLabel: true,
  });
  // hide default zoom/scale controls — we have our own overlay UI
  map.removeControl(map.getControl('AMap.Zoom'));
  map.removeControl(map.getControl('AMap.Scale'));
  // AMap attribution is inside AMapBar control; just ensure it's visible + styled
  map.addControl(new AMap.Control.Bar({ position: 'LB' }));
  // AMap events
  map.on('moveend', _onMoveEndAmap);
  // click set up later via _setupMapClickHandlers
  console.info('[map] basemap: AMap SDK (native tiles)');
}

/* ---------- inset-aware centering ----------
   Pure DOM measurement — identical for both map libraries. The padding values
   are applied differently per library (fitBounds with padding vs setFitView
   + AMap padding option), see the per-branch functions below. */
function mapInsets(){
  const rect = id => { const el = document.getElementById(id); return el ? el.getBoundingClientRect() : null; };
  const deck = rect('deck'), hud = rect('hud'), search = rect('searchBar');
  const bottom = deck ? deck.height : 0;
  const top = Math.max(0, hud ? hud.bottom : 0, search ? search.bottom : 0);
  return { top, bottom };
}
// Convert a WGS point into whatever the current map library expects as a map coord.
function wgsLatLng(p){
  const lat = (p.lat!=null) ? p.lat : p[0], lng = (p.lng!=null) ? p.lng : p[1];
  const g = toMapLL(+lat, +lng);
  if(USING_AMAP) return new AMap.LngLat(g[1], g[0]);   // AMap LngLat(lng, lat)  — NOT [lng,lat] order
  return L.latLng(g[0], g[1]);                         // Leaflet LatLng(lat, lng)
}
function centerOnMap(latlng, zoom, animate){
  if(!map) return;
  const ll = wgsLatLng(latlng);
  if(USING_AMAP){
    map.setZoomAndCenter(zoom, ll, !!animate);
  } else {
    const { top, bottom } = mapInsets();
    map.fitBounds(L.latLngBounds(ll, ll), {
      maxZoom: zoom,
      paddingTopLeft: L.point(0, top),
      paddingBottomRight: L.point(0, bottom),
      animate: !!animate,
    });
  }
}
function fitRouteOnMap(latlngs, animate){
  if(!map || !latlngs || !latlngs.length) return;
  const pts = latlngs.map(wgsLatLng);
  if(USING_AMAP){
    // AMap.setBounds doesn't accept inset padding — we compute the WGS→GCJ box
    // ourselves and expand it 30% for breathing room. Insets are ignored here.
    let minLat=90, maxLat=-90, minLng=180, maxLng=-180;
    latlngs.forEach(p => {
      const g = toMapLL(+p.lat, +p.lng);
      if(g[0]<minLat) minLat=g[0];
      if(g[0]>maxLat) maxLat=g[0];
      if(g[1]<minLng) minLng=g[1];
      if(g[1]>maxLng) maxLng=g[1];
    });
    // add 30% breathing room around the box
    const latPad=(maxLat-minLat)*.15, lngPad=(maxLng-minLng)*.15;
    map.setBounds(new AMap.Bounds(
      new AMap.LngLat(minLng-lngPad, minLat-latPad),
      new AMap.LngLat(maxLng+lngPad, maxLat+latPad)
    ), !!animate);
  } else {
    const { top, bottom } = mapInsets();
    map.fitBounds(L.latLngBounds(pts).pad(.3), {
      paddingTopLeft: L.point(0, top),
      paddingBottomRight: L.point(0, bottom),
      animate: !!animate,
    });
  }
}
function visibleCenterLatLng(){
  if(!map) return { lat:0, lng:0 };
  let ll;
  if(USING_AMAP){
    ll = map.getCenter();
  } else {
    const { top, bottom } = mapInsets();
    const size = map.getSize();
    ll = map.containerPointToLatLng(L.point(size.x / 2, top + (size.y - top - bottom) / 2));
  }
  const w = fromMapLL(ll);   // fromMapLL already returns WGS {lat, lng} in both branches
  return { lat:w.lat, lng:w.lng };
}

/* branch-aware moveend stubs — wired in _loadLeaflet / _initAmap (click handler is set up later via mapReady.then) */
let _onMoveEndLeaflet = null, _onMoveEndAmap = null;

/* remember the last map view (the visible-band centre + zoom), independent of the route */
const MAPVIEW_KEY = 'rsMapView';
let mapViewRestored = false, mapViewTimer = null;
/* ---------- moveend handler (identical API in both branches) ---------- */
function _handleMoveEnd(){ clearTimeout(mapViewTimer); mapViewTimer = setTimeout(() => {
  try{ const c = visibleCenterLatLng(); localStorage.setItem(MAPVIEW_KEY, JSON.stringify({ lat:c.lat, lng:c.lng, z:map.getZoom() })); }catch(e){}
}, 400); }
_onMoveEndLeaflet = _handleMoveEnd;
_onMoveEndAmap = _handleMoveEnd;
function restoreMapView(){
  try{ const v = JSON.parse(localStorage.getItem(MAPVIEW_KEY)||'null');
    if(v && isFinite(v.lat) && isFinite(v.lng)){ centerOnMap([v.lat, v.lng], v.z||12, false); return true; }
  }catch(e){}
  return false;
}

/* ---------- speed modes ---------- */
const SPEED_MODE_KEY='rsSpeedModes';
const SPEED_MODE_DEF={ walk:1.2, run:3.6, bike:10 };
const SPEED_MODE_ORDER=['walk','run','bike'];
const SPEED_FIELDS={ walk:'stWalk', run:'stRun', bike:'stBike' };
function loadSpeedModes(){
  const out=Object.assign({}, SPEED_MODE_DEF);
  try{
    const saved=JSON.parse(localStorage.getItem(SPEED_MODE_KEY)||'null');
    if(saved) SPEED_MODE_ORDER.forEach(m=>{ const v=+saved[m]; if(isFinite(v)&&v>0) out[m]=v; });
  }catch(e){}
  return out;
}
let speedModes=loadSpeedModes();
function saveSpeedModes(){ try{ localStorage.setItem(SPEED_MODE_KEY, JSON.stringify(speedModes)); }catch(e){} }
function modeKmh(m){ return speedModes[m]*3.6; }
function nearestMode(kmh){
  let best='walk', diff=Infinity;
  SPEED_MODE_ORDER.forEach(m=>{ const d=Math.abs(modeKmh(m)-kmh); if(d<diff){ diff=d; best=m; } });
  return best;
}
function fmtMps(v){ return String(+v.toFixed(1)); }
function paintSpeedUI(){
  const val=$('spdVal'); if(!val) return;
  val.textContent=fmtMps(S.speed/3.6)+' m/s';
  document.querySelectorAll('#modeSeg button').forEach(b=>b.classList.toggle('on', b.dataset.mode===S.mode));
  document.querySelectorAll('#modeSeg small').forEach(el=>{ el.textContent=fmtMps(speedModes[el.dataset.mps]); });
}
function setMode(m){
  if(!speedModes[m]) return;
  S.mode=m; S.speed=modeKmh(m);
  paintSpeedUI(); liveSpeed(); persist();
}

/* ---------- state ---------- */
const S = {
  waypoints: [],          // [{lat,lng,dwell,dwellMin,legSpeed}]
  markers: [],            // leaflet markers
  polyline: null,
  polylineCasing: null,
  cum: [0],               // cumulative metres at each waypoint
  total: 0,               // metres
  gpsOn: false,           // broadcasting on/off — the only thing that emits
  phase: 'standing',      // standing | driving | waiting_timed | waiting_go | arrived
  traveled: 0,            // metres along route
  speed: speedModes.walk*3.6,  // km/h (live global, derived from the active mode)
  mode: 'walk',           // walk | run | bike
  rateMs: 1000,           // emit interval
  loop: 'off',            // off(hold) | restart | pingpong
  locked: false,          // manual lock — when true, map taps don't add/move points (session-only)
  holdRemainingMs: 0,     // for waiting_timed
  holdWaypoint: -1,       // index being waited at
  lastFrame: 0,
  lastEmit: 0,
  elapsedMs: 0,
  emitCount: 0,
  emitMarker: null,
  bearingEl: null,
};
const isDriving = () => S.phase === 'driving';
// A run exists to stop whenever playback is past the idle/parked state.
// 'standing' is the only idle phase (pause uses waiting_go; turning GPS off
// mid-run leaves the phase intact) — so this is independent of GPS state.
const isPlaybackActive = () => S.phase !== 'standing';

/* ---------- geo math (mirrors the native Kotlin interpolation) ---------- */
const R = 6371000;
const rad = d => d*Math.PI/180, deg = r => r*180/Math.PI;
function haversine(a,b){
  const dLat=rad(b.lat-a.lat), dLng=rad(b.lng-a.lng);
  const s=Math.sin(dLat/2)**2 + Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
function bearing(a,b){
  const y=Math.sin(rad(b.lng-a.lng))*Math.cos(rad(b.lat));
  const x=Math.cos(rad(a.lat))*Math.sin(rad(b.lat))-Math.sin(rad(a.lat))*Math.cos(rad(b.lat))*Math.cos(rad(b.lng-a.lng));
  return (deg(Math.atan2(y,x))+360)%360;
}
const COMPASS=['N','NE','E','SE','S','SW','W','NW'];
const compass = b => COMPASS[Math.round(b/45)%8];

/* position + heading at arclength s (metres) along the route */
function sampleAt(s){
  if(S.waypoints.length===0) return null;
  if(S.waypoints.length===1) return { ...S.waypoints[0], brg:0, seg:0 };
  s = Math.max(0, Math.min(s, S.total));
  let i=0; while(i<S.cum.length-2 && s>S.cum[i+1]) i++;
  const a=S.waypoints[i], b=S.waypoints[i+1];
  const segLen=S.cum[i+1]-S.cum[i] || 1;
  const t=(s-S.cum[i])/segLen;
  return { lat:a.lat+(b.lat-a.lat)*t, lng:a.lng+(b.lng-a.lng)*t, brg:bearing(a,b), seg:i };
}

/* ---------- route building ---------- */
function recompute(){
  S.cum=[0];
  for(let i=1;i<S.waypoints.length;i++) S.cum[i]=S.cum[i-1]+haversine(S.waypoints[i-1],S.waypoints[i]);
  S.total=S.cum[S.cum.length-1]||0;
  drawRoute();
  syncTools();
  paintHud();
}
/* ---------- route polyline (AMap vs Leaflet branch) ---------- */
function drawRoute(){
  if(S.polyline){ try{ S.polyline.setMap ? S.polyline.setMap(null) : S.polyline.remove(); }catch(e){} }
  if(S.polylineCasing){ try{ S.polylineCasing.setMap ? S.polylineCasing.setMap(null) : S.polylineCasing.remove(); }catch(e){} }
  if(S.waypoints.length<=1){ S.polyline=null; S.polylineCasing=null; return; }
  const ptsWgs = S.waypoints.map(p=>toMapLL(p.lat,p.lng));   // GCJ-02 [lat, lng] in both branches
  if(USING_AMAP){
    // AMap uses [lng, lat] order, polyline doesn't support dashArray natively → strokeDasharray
    const toAmapPts = ptsWgs.map(p => new AMap.LngLat(p[1], p[0]));
    S.polylineCasing = new AMap.Polyline({
      path: toAmapPts, strokeColor:'#0a2230', strokeWeight:6, strokeOpacity:0.35,
      strokeStyle:'solid', lineJoin:'round', lineCap:'round', zIndex:50
    });
    S.polyline = new AMap.Polyline({
      path: toAmapPts, strokeColor:getCSS('--route'), strokeWeight:4, strokeOpacity:1,
      strokeStyle:'dashed', strokeDasharray:[1,9], lineJoin:'round', lineCap:'round', zIndex:51
    });
    S.polylineCasing.setMap(map); S.polyline.setMap(map);
  } else {
    S.polylineCasing=L.polyline(ptsWgs,{color:'#0a2230',weight:6,opacity:.35,lineCap:'round',interactive:false}).addTo(map);
    S.polyline=L.polyline(ptsWgs,{color:getCSS('--route'),weight:4,opacity:1,dashArray:'1 9',lineCap:'round'}).addTo(map);
  }
}
const wpLabel = i => String.fromCharCode(65+i);
function _wpHtml(i){
  const n=S.waypoints.length;
  const cls = i===0?'wp start' : i===n-1&&n>1?'wp end' : 'wp';
  return `<div class="${cls}"><b>${wpLabel(i)}</b></div>`;
}
/* ---------- waypoint markers ---------- */
function refreshMarkers(){
  // remove existing (AMap uses setMap(null), Leaflet uses remove())
  S.markers.forEach(m=>{ try{ m.setMap ? m.setMap(null) : m.remove(); }catch(e){} });
  S.markers=[];
  S.waypoints.forEach((p,i)=>{
    let m;
    if(USING_AMAP){
      m = new AMap.Marker({
        position: toMapLL(p.lat,p.lng).reverse(),   // [lng, lat] for AMap
        content: _wpHtml(i),
        offset: new AMap.Pixel(-12, -12),
        draggable: !S.locked,
        zIndex: 1000,
        cursor: !S.locked ? 'move' : 'default'
      });
      m.setMap(map);
    } else {
      m = L.marker(toMapLL(p.lat,p.lng),{
        icon:L.divIcon({className:'', html:_wpHtml(i), iconSize:[24,24], iconAnchor:[12,12]}),
        draggable:!S.locked, zIndexOffset:1000
      }).addTo(map);
    }
    let dragPos=null;
    const onDrag = e => {
      const ll = USING_AMAP ? e.lnglat : e.target.getLatLng();
      const w = fromMapLL(ll);
      S.waypoints[i].lat=w.lat; S.waypoints[i].lng=w.lng;
      if(S.polyline){
        const pts = S.waypoints.map(q=>toMapLL(q.lat,q.lng));
        if(USING_AMAP){
          const amapPts = pts.map(p => new AMap.LngLat(p[1], p[0]));
          S.polyline.setPath(amapPts); S.polylineCasing && S.polylineCasing.setPath(amapPts);
        } else {
          S.polyline.setLatLngs(pts); if(S.polylineCasing) S.polylineCasing.setLatLngs(pts);
        }
      }
    };
    const onDragEnd = () => {
      recompute();
      if(S.gpsOn && isNative){ FakeGps.moveWaypoint({index:i,lat:S.waypoints[i].lat,lng:S.waypoints[i].lng}).catch(()=>{}); }
      else if(dragPos){ previewReanchor(dragPos); }
      dragPos=null; persistSoon();
    };
    // drag events (different names in AMap vs Leaflet)
    if(USING_AMAP){
      m.on('dragging', onDrag);
      m.on('dragend', onDragEnd);
    } else {
      m.on('drag', onDrag);
      m.on('dragend', onDragEnd);
    }
    // long-press / right-click menu + dragstart (same in both)
    let timer=null;
    const startPress=()=>{ timer=setTimeout(()=>openWpMenu(i), 550); };
    const cancelPress=()=>{ if(timer){ clearTimeout(timer); timer=null; } };
    if(USING_AMAP){
      m.on('mousedown',startPress); m.on('touchstart',startPress);
      m.on('dragstart',()=>{ dragPos=(!isNative&&S.gpsOn)?PV.worldPos():null; cancelPress(); });
      m.on('mouseup',cancelPress); m.on('touchend',cancelPress); m.on('mousemove',cancelPress);
      m.on('rightclick',()=>openWpMenu(i));
    } else {
      m.on('mousedown',startPress); m.on('touchstart',startPress);
      m.on('dragstart',()=>{ dragPos=(!isNative&&S.gpsOn)?PV.worldPos():null; cancelPress(); });
      m.on('mouseup',cancelPress); m.on('touchend',cancelPress); m.on('move',cancelPress);
      m.on('contextmenu',()=>openWpMenu(i));
      m.bindTooltip(wpLabel(i),{direction:'top',offset:[0,-12],opacity:.9});
    }
    S.markers.push(m);
  });
}
const newWp = latlng => ({lat:latlng.lat,lng:latlng.lng,dwell:'none',dwellMin:2,legSpeed:null});
function addWaypoint(latlng){
  S.waypoints.push(newWp(latlng));
  // tapping while broadcasting appends to the tail (extends the route)
  if(S.gpsOn && isNative) FakeGps.appendWaypoint({lat:latlng.lat,lng:latlng.lng}).catch(()=>{});
  refreshMarkers(); recompute(); hideHint(); persist();
}
function removeWaypoint(i){
  const before=(!isNative&&S.gpsOn)?PV.worldPos():null;
  S.waypoints.splice(i,1);
  if(S.gpsOn && isNative) FakeGps.removeWaypoint({index:i}).catch(()=>{});
  refreshMarkers(); recompute();
  if(S.waypoints.length===0) hardReset();
  else if(before) previewReanchor(before);
  persist();
}

// A map tap while the control deck is up lowers the deck instead of dropping a point,
// so reaching for the map to get the panel out of the way can't litter the route with
// accidental waypoints. The next tap (deck down) adds the point as usual.
/* ---------- click handler for adding waypoints ----------
   Leaflet fires click with e.latlng (LatLng(lat, lng) — GCJ-02 because basemap is GCJ).
   AMap fires click with e.lnglat (LngLat(lng, lat) — always GCJ-02).
   fromMapLL converts GCJ → WGS in both branches. */
const _addWpOnClick = llGcj => {
  if(S.locked) return;
  if(!document.body.classList.contains('deck-collapsed')){ setDeckCollapsed(true); refreshHint(); return; }
  addWaypoint(fromMapLL(llGcj));
};
// Wire click handler after init (satisfies definition order since addWaypoint is declared above).
mapReady.then(() => {
  if(!map) return;
  if(USING_AMAP){
    map.on('click', e => _addWpOnClick({ lat:e.lnglat.getLat(), lng:e.lnglat.getLng() }));
  } else {
    map.on('click', e => _addWpOnClick(e.latlng));
  }
});

/* ---------- unified render: a normalized drive snapshot -> pill + marker + HUD ---------- */
function applyDrive(st){
  S.phase = st.phase;
  S.traveled = (st.traveled!=null) ? st.traveled : S.traveled;
  S.holdRemainingMs = st.holdRemainingMs||0;
  S.holdWaypoint = (st.holdWaypoint==null) ? -1 : st.holdWaypoint;
  document.body.dataset.phase = st.phase;
  document.getElementById('stateLabel').textContent = statusText();
  document.getElementById('goIcon').innerHTML = isDriving()
    ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>'      // pause
    : '<path d="M8 5v14l11-7z"/>';                  // GO
  if(!S.emitMarker) ensureEmitter();
  moveEmitter({lat:st.lat,lng:st.lng,brg:st.brg||0,seg:st.seg||0});
  paintLive(st);
  syncTools();
}
function statusText(){
  switch(S.phase){
    case 'driving':  return t('status.driving');
    case 'arrived':  return t('status.arrived');
    case 'waiting_go': return t('status.waitingGo');
    case 'waiting_timed':
      return `${t('status.waitingAt')} ${fmtTime((S.holdRemainingMs||0)/1000)} ${t('status.atWp')} ${S.holdWaypoint>=0?wpLabel(S.holdWaypoint):''}`.trim();
    default: return t('status.standing');
  }
}
// HUD stat chips scroll horizontally on narrow phones; fade whichever edge still
// has off-screen chips so a clipped value reads as "scroll for more", not a bug.
function updateChipFade(){
  const el = document.querySelector('.chips');
  if(!el) return;
  const more = el.scrollWidth - el.clientWidth;
  if(more <= 1){ el.removeAttribute('data-of'); return; }
  const atStart = el.scrollLeft <= 1;
  const atEnd   = el.scrollLeft >= more - 1;
  el.dataset.of = atStart ? 'right' : atEnd ? 'left' : 'both';
}
function paintLive(st){
  const spd = (st.speedKmh!=null) ? st.speedKmh : (isDriving()?S.speed:0);
  document.getElementById('cSpd').textContent=(spd/3.6).toFixed(1);
  const brg = st.brg||0;
  document.getElementById('cHdg').textContent=`${compass(brg)} ${Math.round(brg)}°`;
  const prg = Math.round(((st.progress!=null)?st.progress:(S.total?S.traveled/S.total:0))*100);
  document.getElementById('cPrg').textContent=prg+'%';
  document.getElementById('cDst').textContent=(S.total/1000).toFixed(2)+' km';
  updateChipFade();
  document.getElementById('railFill').style.width=prg+'%';
  document.getElementById('liveSeg').textContent=(((st.seg!=null)?st.seg:0)+1)+'/'+Math.max(0,S.waypoints.length-1);
  renderLiveCoord({lat:st.lat,lng:st.lng});
  document.getElementById('liveElapsed').textContent=fmtTime(((st.elapsedMs!=null)?st.elapsedMs:S.elapsedMs)/1000);
}

/* =====================================================================
   BROWSER preview engine — a JS port of the native RouteEngine. Drives the
   cursor while GPS is on; mirrors hold/wake/dwell/per-leg-speed/hold-at-end.
   Uses the shared S.waypoints / S.cum / S.total geometry so live tail edits
   are picked up automatically. Disabled on native (the Kotlin engine drives).
   ===================================================================== */
const PV = (function(){
  const EPS=1e-6;
  let traveled=0, phase='standing', holdRemainingMs=0, holdWaypoint=-1, forward=true, running=false, last=0, lastEmit=0;
  const curSeg=()=>{ if(S.waypoints.length<2) return 0; let i=0; while(i<S.cum.length-2 && traveled>=S.cum[i+1]-EPS) i++; return i; };
  const curWp=()=>{ for(let k=0;k<S.cum.length;k++) if(Math.abs(traveled-S.cum[k])<=EPS) return k; return -1; };
  // keep the driver's world position continuous when geometry is edited
  const worldPos=()=>sampleAt(traveled)||{lat:0,lng:0};
  function reanchor(p){
    if(S.waypoints.length<2){ traveled=0; return; }
    let best=Infinity, bestArc=0;
    for(let i=0;i<S.waypoints.length-1;i++){
      const a=S.waypoints[i], b=S.waypoints[i+1];
      const abLat=b.lat-a.lat, abLng=b.lng-a.lng, len2=abLat*abLat+abLng*abLng;
      const tt=len2===0?0:Math.max(0,Math.min(1,((p.lat-a.lat)*abLat+(p.lng-a.lng)*abLng)/len2));
      const dLat=p.lat-(a.lat+abLat*tt), dLng=p.lng-(a.lng+abLng*tt), d2=dLat*dLat+dLng*dLng;
      if(d2<best){ best=d2; bestArc=S.cum[i]+tt*(S.cum[i+1]-S.cum[i]); }
    }
    traveled=Math.max(0,Math.min(bestArc,S.total));
    if(S.waypoints.length<2 && phase==='driving') phase='standing';
  }
  const legSpeed=()=>{ if(S.waypoints.length<2) return 0; const tg=Math.min(curSeg()+1,S.waypoints.length-1);
    const o=S.waypoints[tg].legSpeed; return (o!=null)?o:S.speed; };
  function nextStop(){ const lastI=S.waypoints.length-1; let k=curSeg()+1; while(k<lastI && (S.waypoints[k].dwell||'none')==='none') k++; return k; }
  function resume(){ phase='driving'; forward=true; holdRemainingMs=0; holdWaypoint=-1; }
  function enterHold(k){ const lastI=S.waypoints.length-1;
    if(k===lastI){ if(S.loop==='restart'){ traveled=0; phase='driving'; }
      else if(S.loop==='pingpong'){ forward=false; phase='driving'; }
      else { phase='arrived'; holdWaypoint=k; } return; }
    const d=S.waypoints[k].dwell||'none';
    if(d==='timed'){ phase='waiting_timed'; holdRemainingMs=Math.round((S.waypoints[k].dwellMin||0)*60000); holdWaypoint=k; }
    else if(d==='until-go'){ phase='waiting_go'; holdWaypoint=k; } }
  function stepMs(dt){
    if(phase==='driving'){
      if(S.waypoints.length<2){ phase='standing'; return; }
      const dm=legSpeed()/3.6*(dt/1000); if(dm<=0) return;
      if(forward){ const k=nextStop(), tgt=S.cum[k];
        if(traveled+dm>=tgt-EPS){ traveled=tgt; enterHold(k); } else traveled+=dm; }
      else if(traveled-dm<=EPS){ traveled=0; forward=true; } else traveled-=dm;
    } else if(phase==='waiting_timed'){ holdRemainingMs-=dt; if(holdRemainingMs<=0){ holdRemainingMs=0; resume(); } }
  }
  function snapshot(){ const f=sampleAt(traveled)||{lat:0,lng:0,brg:0,seg:0}; const driving=phase==='driving';
    return { lat:f.lat,lng:f.lng,brg:f.brg,seg:f.seg, phase, speedKmh:driving?legSpeed():0,
      traveled, progress:S.total>0?Math.max(0,Math.min(1,traveled/S.total)):0,
      holdRemainingMs:phase==='waiting_timed'?holdRemainingMs:0, holdWaypoint,
      elapsedMs:S.elapsedMs }; }
  function frame(now){ if(!running) return; const dt=now-last; last=now;
    if(phase==='driving') S.elapsedMs+=dt;
    stepMs(dt); const snap=snapshot(); applyDrive(snap);
    if(now-lastEmit>=S.rateMs){ lastEmit=now; logFix({lat:snap.lat,lng:snap.lng,speedKmh:Math.round(snap.speedKmh),bearing:Math.round(snap.brg),timestamp:Date.now()}); }
    requestAnimationFrame(frame); }
  return {
    start(){ running=true; last=performance.now(); lastEmit=0; requestAnimationFrame(frame); },
    stop(){ running=false; },
    go(){ if(S.waypoints.length<2){ phase='standing'; return; } if(phase==='arrived'&&traveled>=S.total-EPS) return; resume(); },
    pauseDrive(){ if(phase==='driving'){ phase='waiting_go'; holdWaypoint=curWp(); } },
    resetCursor(){ traveled=0; phase='standing'; forward=true; holdRemainingMs=0; holdWaypoint=-1; S.elapsedMs=0; },
    snapshot, worldPos, reanchor,
  };
})();
// re-anchor the preview cursor after a geometry edit so the position stays put
function previewReanchor(before){ if(!isNative && S.gpsOn){ PV.reanchor(before); applyDrive(PV.snapshot()); } }

/* =====================================================================
   CONTROL — GPS toggle (broadcast) is independent of GO/Pause (movement).
   On native these map to the plugin; otherwise they drive PV (preview).
   ===================================================================== */
function routePayload(){
  return {
    waypoints: S.waypoints.map(p=>({
      lat:p.lat, lng:p.lng,
      dwell:p.dwell||'none', dwellMs:Math.round((p.dwellMin||0)*60000),
      legSpeedKmh:(p.legSpeed!=null)?p.legSpeed:null,
    })),
    speedKmh:S.speed, intervalMs:S.rateMs, loop:S.loop,
  };
}
async function gpsTurnOn(){
  if(S.waypoints.length<1){ flashHint(t('hint.dropFirst')); return; }
  if(isNative){
    const st = await refreshReady();
    if(!st || !st.ready){ openSetup(); flashHint(t('hint.finishSetup')); return; }
  }
  clearLog(); S.emitCount=0; S.elapsedMs=0; ensureEmitter();
  S.gpsOn=true; document.body.dataset.gps='on';
  if(isNative){
    try{ await FakeGps.setRoute(routePayload()); await FakeGps.startGps(); }
    catch(e){ console.warn('startGps failed',e); flashHint(t('hint.couldNotStart')); S.gpsOn=false; document.body.dataset.gps='off'; return; }
  } else { PV.start(); applyDrive(PV.snapshot()); }
  syncTools();
}
async function gpsTurnOff(){
  S.gpsOn=false; document.body.dataset.gps='off';
  if(isNative){ try{ await FakeGps.stopGps(); }catch(e){ console.warn(e);} }
  else { PV.stop(); applyDrive(PV.snapshot()); }
  syncTools();
}
function toggleGps(){ S.gpsOn ? gpsTurnOff() : gpsTurnOn(); }
/* GO can't run until GPS is broadcasting and the route has 2+ points. The button is
   dimmed but never `disabled`, so a tap on it says WHICH of the two is missing —
   and when it's the GPS switch, flags the icon to tap first. */
function setGoReady(){
  const b=$('go');
  b.setAttribute('aria-disabled', (S.gpsOn && S.waypoints.length>=2) ? 'false' : 'true');
}
function nudgeGps(){
  const b=$('gps'); b.classList.remove('nudge');
  void b.offsetWidth;                 // restart the animation on a repeat tap
  b.classList.add('nudge');
  setTimeout(()=>b.classList.remove('nudge'), 1600);
}
async function pressGo(){
  if(!S.waypoints.length){ flashHint(t('hint.dropFirst')); return; }
  if(S.waypoints.length<2){ flashHint(t('hint.needTwo')); return; }
  if(!S.gpsOn){ flashHint(t('hint.gpsFirst')); nudgeGps(); return; }
  if(isDriving()){ if(isNative){ try{ await FakeGps.pause(); }catch(e){ console.warn(e);} } else PV.pauseDrive(); }
  else { if(isNative){ try{ await FakeGps.go(); }catch(e){ console.warn(e);} } else PV.go(); }
  if(!isNative) applyDrive(PV.snapshot());
}
function pressStop(){
  if(!isPlaybackActive()) return;   // nothing running/paused — Stop is a no-op when idle
  if(isNative){ try{ FakeGps.stop(); }catch(e){ console.warn(e);} }
  else { PV.resetCursor(); applyDrive(PV.snapshot()); }
}
function hardReset(){      // the route was emptied
  if(isNative){ try{ FakeGps.stopGps(); }catch(e){ console.warn(e);} } else { PV.stop(); PV.resetCursor(); }
  S.gpsOn=false; S.phase='standing'; S.traveled=0; S.elapsedMs=0; S.holdRemainingMs=0; S.holdWaypoint=-1;
  document.body.dataset.gps='off'; document.body.dataset.phase='standing';
  if(S.emitMarker){ S.emitMarker.remove(); S.emitMarker=null; }
  document.getElementById('stateLabel').textContent=statusText();
  document.getElementById('goIcon').innerHTML='<path d="M8 5v14l11-7z"/>';   // back to GO (was pause mid-drive)
  document.getElementById('railFill').style.width='0%';
  document.getElementById('liveElapsed').textContent='00:00';
  paintHud();              // speed / heading / progress / distance / seg back to zero
  renderLiveCoord(sampleAt(0)); syncTools(); refreshHint();
}
/* The single "clear route" path — the deck Clear tool and the floating map button
   both land here. A running/paused run is stopped through the Stop button's path
   first; hardReset() then switches GPS off. Viewport, speed, emit interval and loop
   mode are left as they are. */
function clearRoute(){
  if(!S.waypoints.length) return;
  if(S.waypoints.length>=3 && !confirm(t('map.clearConfirm'))) return;
  pressStop();
  S.waypoints=[]; refreshMarkers(); recompute(); hardReset(); persist();
}

/* a fix streamed back from the native clock (single source of truth on native) */
function applyNativeFix(f){
  if(!f) return;
  // stopGps() answers with a final snapshot of the route the service still holds; after
  // a clear there is nothing to draw it on (and GPS can't be on without points).
  if(!S.waypoints.length) return;
  S.gpsOn = !!f.gpsOn; document.body.dataset.gps = f.gpsOn ? 'on' : 'off';
  applyDrive({                                   // -> syncTools() -> setGoReady()
    lat:f.lat, lng:f.lng, brg:f.bearing, seg:f.segIndex||0,
    phase:f.phase||'standing', speedKmh:f.speedKmh,
    traveled:(f.traveled!=null)?f.traveled:((f.progress||0)*S.total),
    progress:f.progress, holdRemainingMs:f.holdRemainingMs,
    holdWaypoint:f.holdWaypoint, elapsedMs:f.elapsedMs,
  });
  if(f.gpsOn) logFix({ lat:f.lat, lng:f.lng, speedKmh:f.speedKmh, bearing:Math.round(f.bearing||0), timestamp:Date.now() });
}
/* ---------- the EMITTER (moving marker) ---------- */
/* ---------- the EMITTER (moving marker) ---------- */
function _emitHtml(brg){ return `<div class="emitter"><span class="bearing" style="transform:rotate(${brg}deg)"></span><i></i></div>`; }
function ensureEmitter(){
  const f=sampleAt(S.traveled); if(!f) return;
  // remove old
  if(S.emitMarker){ try{ S.emitMarker.setMap ? S.emitMarker.setMap(null) : S.emitMarker.remove(); }catch(e){} }
  if(USING_AMAP){
    S.emitMarker = new AMap.Marker({
      position: toMapLL(f.lat,f.lng).reverse(),   // [lng, lat]
      content: _emitHtml(f.brg||0),
      offset: new AMap.Pixel(-9, -9),
      zIndex: 5000,
      cursor: 'default'
    });
    S.emitMarker.setMap(map);
  } else {
    const el=L.divIcon({className:'',html:_emitHtml(f.brg||0),iconSize:[18,18],iconAnchor:[9,9]});
    S.emitMarker=L.marker(toMapLL(f.lat,f.lng),{icon:el,zIndexOffset:5000,interactive:false}).addTo(map);
  }
}
function moveEmitter(fix){
  if(!fix) return;
  if(!S.emitMarker) ensureEmitter();
  const pos = USING_AMAP
    ? toMapLL(fix.lat,fix.lng).reverse()                        // [lng, lat]
    : toMapLL(fix.lat,fix.lng);                                 // [lat, lng]
  if(USING_AMAP){
    S.emitMarker.setPosition(pos);
    // AMap marker.setContent accepts an HTML string — we rebuild to embed the bearing rotation
    S.emitMarker.setContent(_emitHtml(fix.brg||0));
  } else {
    S.emitMarker.setLatLng(pos);
    const mEl=S.emitMarker.getElement(); const b=mEl && mEl.querySelector('.bearing');
    if(b) b.style.transform=`rotate(${fix.brg}deg)`;
  }
}

/* ---------- HUD paint (static / standing) — live driving uses paintLive ---------- */
function paintHud(){
  const fix = S.waypoints.length ? sampleAt(S.traveled) : null;
  document.getElementById('cSpd').textContent=((isDriving()?S.speed:0)/3.6).toFixed(1);
  document.getElementById('cHdg').textContent= fix? `${compass(fix.brg)} ${Math.round(fix.brg)}°` : '—';
  const prg=S.total? Math.round(S.traveled/S.total*100):0;
  document.getElementById('cPrg').textContent=prg+'%';
  document.getElementById('cDst').textContent=(S.total/1000).toFixed(2)+' km';
  updateChipFade();
  document.getElementById('railFill').style.width=prg+'%';
  document.getElementById('liveSeg').textContent=(fix?fix.seg+1:0)+'/'+Math.max(0,S.waypoints.length-1);
  renderLiveCoord(fix);
}
function renderLiveCoord(fix){
  const el=document.getElementById('liveCoord');
  if(!fix){ el.innerHTML=`<span class="mut">${t('live.noRoute')}</span>`; return; }
  el.innerHTML=`<span class="mut">lat</span> ${fix.lat.toFixed(6)} &nbsp;<span class="mut">lng</span> ${fix.lng.toFixed(6)}`;
}
const fmtTime=s=>`${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`;

/* ---------- emit log ---------- */
function logFix(o){
  if(!o || typeof o !== 'object') return;
  if(o.lat == null || o.lng == null) return;
  S.emitCount++; document.getElementById('logCount').textContent=S.emitCount;
  const wrap=document.getElementById('logwrap');
  const line=document.createElement('div'); line.className='logline';
  const t=new Date(o.timestamp || Date.now()).toLocaleTimeString('en-GB',{hour12:false});
  const spd = o.speedKmh != null ? o.speedKmh : 0;
  const brg = o.bearing != null ? Math.round(o.bearing) : 0;
  line.innerHTML=`<span class="t">${t}</span>  ${(+o.lat).toFixed(6)}, ${(+o.lng).toFixed(6)}  ·  ${spd}km/h ${brg}°`;
  wrap.prepend(line);
  while(wrap.children.length>40) wrap.lastChild.remove();
}
function clearLog(){ document.getElementById('logwrap').innerHTML=''; document.getElementById('logCount').textContent='0'; }

/* ---------- controls ---------- */
const $=id=>document.getElementById(id);
$('gps').onclick=toggleGps;
$('go').onclick=pressGo;
$('stop').onclick=pressStop;

function liveSpeed(){              // mode speed regulates all legs without an override, live
  if(S.gpsOn && isNative){ FakeGps.setSpeed({speedKmh:S.speed}).catch(()=>{}); }
}
$('modeSeg').onclick=e=>{ const b=e.target.closest('button'); if(!b) return; setMode(b.dataset.mode); };
paintSpeedUI();

$('rate').oninput=e=>{ S.rateMs=Math.round(+e.target.value*1000); const s=(S.rateMs/1000).toFixed(1);
  $('rateVal').textContent=s+' s'; $('liveRate').textContent=s+'s';
  if(S.gpsOn && isNative){ FakeGps.setInterval({intervalMs:S.rateMs}).catch(()=>{}); }
  persist(); };

$('loopSeg').onclick=e=>{ const b=e.target.closest('button'); if(!b)return;
  S.loop=b.dataset.loop; syncLoopUI();
  if(S.gpsOn && isNative){ FakeGps.setLoop({loop:S.loop}).catch(()=>{}); }
  persist(); };

// Route-building tools work while NOT broadcasting (live tail edits use tap / the waypoint menu).
$('undo').onclick=()=>{ if(S.gpsOn||!S.waypoints.length)return; S.waypoints.pop(); refreshMarkers(); recompute(); persist(); };
$('clear').onclick=clearRoute;     // clearRoute() already calls pressStop() internally — consistent with the floating map button
$('mapClear').onclick=clearRoute;
$('reverse').onclick=()=>{ if(S.gpsOn||S.waypoints.length<2)return; S.waypoints.reverse(); refreshMarkers(); recompute(); persist(); };
$('lock').onclick=toggleLock;

/* A geolocation failure is not proof that location services are off (#4563): a plain
   timeout or an unavailable provider rejects too. Blaming "location is off" for every
   rejection sent testers to a Settings screen that was already correct — so read the
   error out instead. The browser preview's web PositionError uses codes 1 / 2 / 3. */
function geoErrHint(e){
  const s=((e&&e.code)!=null?String(e.code):'')+' '+((e&&e.message)||'');
  if(/GLOC-0007/.test(s)) return t('hint.locationDenied');
  if(/GLOC-0003/.test(s) || (e&&e.code===1)) return t('hint.locationBlocked');
  if(/GLOC-0010/.test(s) || (e&&e.code===3)) return t('hint.locationTimeout');
  return t('hint.geoUnavailable');
}
/* ---------- real device position — shared by the deck "My location" tool and the
   floating locate button ---------- */
// FIX 5 — check permission up front (fast flag read, not a GPS fix) so a missing
// permission never burns the whole timeout on a geolocation request.
async function ensureLocationPermission(){
  if(!(isNative && FakeGps)) return true;
  let st=await refreshReady();
  if(st.locationPermission) return true;
  let granted=false;
  try{ await FakeGps.requestPermissions(); st=await refreshReady(); granted=!!st.locationPermission; }
  catch(e){ console.warn(e); }
  if(!granted){
    // declined / permanently denied → actionable wording + deep link to app settings
    flashHint(t('hint.locationBlocked'));
    if(FakeGps.openAppSettings){ try{ await FakeGps.openAppSettings(); }catch(e){ console.warn(e);} }
  }
  return granted;
}
const REAL_FIX_TIMEOUT_MS=15000;
// One fresh high-accuracy fix -> {lat,lng,accuracy,isMock}. On native, FakeGps.getRealFix
// serves it via Fused when Play Services exists and via the framework LocationManager
// otherwise, so no-GMS devices (Huawei etc.) never touch a Google API — the old
// Capacitor-Geolocation fallback popped the Play Services "not supported" dialog there
// (#4528 follow-up). The browser preview uses the plain web Geolocation API.
function getRealFix(){
  const fromCoords = c => ({ lat:c.latitude, lng:c.longitude, accuracy:c.accuracy||0, isMock:false });
  const fix = new Promise((res,rej)=>{
    if(isNative && FakeGps && FakeGps.getRealFix){
      FakeGps.getRealFix().then(res, rej);
    } else if(navigator.geolocation){
      navigator.geolocation.getCurrentPosition(p=>res(fromCoords(p.coords)), rej, {enableHighAccuracy:true, timeout:REAL_FIX_TIMEOUT_MS, maximumAge:0});
    } else rej({code:'unavailable'});
  });
  let timer=null;
  const timeout = new Promise((res,rej)=>{ timer=setTimeout(()=>rej({code:'timeout'}), REAL_FIX_TIMEOUT_MS); });
  return Promise.race([fix,timeout]).then(v=>{ clearTimeout(timer); return v; }, e=>{ clearTimeout(timer); throw e; });
}
// the device's real position: blue dot + accuracy ring, distinct from A/B/C and the emitter
let realPos=null;
function showRealPosition(f){
  const ll=toMapLL(f.lat,f.lng), r=Math.max(f.accuracy||0, 1);
  if(realPos){ realPos.ring.setLatLng(ll).setRadius(r); realPos.dot.setLatLng(ll); return; }
  realPos={
    ring:L.circle(ll,{radius:r, color:'#4285F4', weight:1, opacity:.6, fillColor:'#4285F4', fillOpacity:.15, interactive:false}).addTo(map),
    dot:L.circleMarker(ll,{radius:7, color:'#fff', weight:2, opacity:1, fillColor:'#4285F4', fillOpacity:1, interactive:false}).addTo(map),
  };
}
// The mock injector is live whenever GPS broadcasts or a run is running/paused — a
// "real" fix then is our own injected one.
const mockActive = () => S.gpsOn || isPlaybackActive();
let locating=false;
function setLocating(on){
  locating=on;
  $('locate').disabled=on;
  $('mapLocate').classList.toggle('busy', on);
}
async function locateMe(fromMap){
  // a second tap while the first fix is still pending used to fire a second, concurrent
  // native request — the two raced and one of them rejected (#4563)
  if(locating) return;
  if(mockActive()){
    if(fromMap){ flashHint(t('locate.stopPlayback')); return; }
    // The deck tool keeps #4563: while broadcasting, the device's location IS the fix
    // we push, so centre on the cursor read off the route instead.
    const f=sampleAt(S.traveled);
    if(f){ centerOnMap([f.lat,f.lng],15,true); flashHint(t('hint.centeredMock')); return; }
  }
  if(!(await ensureLocationPermission())) return;
  setLocating(true);
  flashHint(t('hint.locating'));
  try{
    const f=await getRealFix();
    if(f.isMock){ flashHint(t('locate.stopPlayback')); return; }
    centerOnMap([f.lat,f.lng], Math.max(16, map.getZoom()), true);
    showRealPosition(f);
    flashHint(t('hint.centered'));
  }catch(e){
    if(e && e.code==='permission') flashHint(t('hint.locationBlocked'));
    else if(e && (e.code==='timeout' || e.code===3 || /GLOC-0010/.test(String(e.code)))) flashError(t('locate.timeout'));
    else flashHint(geoErrHint(e));
  }
  finally{ setLocating(false); }
}
$('locate').onclick=()=>locateMe(false);
$('mapLocate').onclick=()=>locateMe(true);

function syncTools(){
  const n=S.waypoints.length, building=!S.gpsOn;
  $('undo').disabled = n===0 || !building;
  $('clear').disabled = n===0 || !building;
  $('reverse').disabled = n<2 || !building;
  $('mapClear').hidden = n===0;
  $('mapLocate').setAttribute('aria-disabled', mockActive() ? 'true' : 'false');   // tappable: explains why
  // Stop reflects whether there's a running/paused simulation to stop — gated on
  // playback state only, never on GPS (#4527): a run stays stoppable even if GPS
  // is switched off mid-playback.
  $('stop').disabled = !isPlaybackActive();
  setGoReady();
}
// open / closed padlock glyphs — swapped to reflect the lock state
const LOCK_OPEN_PATH='M12 17a2 2 0 002-2 2 2 0 00-2-2 2 2 0 00-2 2 2 2 0 002 2zm6-9h-9V6a3.1 3.1 0 016.2 0h1.8A5 5 0 007 6v2H6a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V10a2 2 0 00-2-2z';
const LOCK_CLOSED_PATH='M12 17a2 2 0 002-2 2 2 0 00-2-2 2 2 0 00-2 2 2 2 0 002 2zm6-9h-1V6a5 5 0 00-10 0v2H6a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V10a2 2 0 00-2-2zM8.9 6a3.1 3.1 0 016.2 0v2H8.9V6z';
function syncLock(){
  const btn=$('lock'); if(!btn) return;
  btn.classList.toggle('on', S.locked);
  btn.setAttribute('aria-pressed', S.locked ? 'true' : 'false');
  $('lockIcon').innerHTML = `<path d="${S.locked ? LOCK_CLOSED_PATH : LOCK_OPEN_PATH}"/>`;
  $('lockLabel').textContent = S.locked ? t('tool.locked') : t('tool.lock');
}
function toggleLock(){ S.locked = !S.locked; refreshMarkers(); syncLock(); }

/* Loop mode is shown on more than one surface and is set from four places (the
   segmented control, cold boot, loading a saved route, a locale switch) — render
   all of it from one function so the surfaces can't drift out of sync. */
const LOOP_MODES = ['off','restart','pingpong'];
/* S.loop arrives from localStorage and from imported route files, and neither path
   validates it (nz(d.loop,'off') and r.loop||'off' only guard against null). An
   unknown id must read as 'off' here — the same fallback both engines already
   apply (LoopMode.fromId -> HOLD; the JS enterHold else-branch). */
function loopMode(){ return LOOP_MODES.indexOf(S.loop) >= 0 ? S.loop : 'off'; }
// 24-box glyphs for the GO badge, swapped by innerHTML the way syncLock() swaps the padlock
const LOOP_RESTART_GLYPH='<path d="M20 12A8 8 0 1 1 12 4"/><path d="M9 1l3 3-3 3"/>';          // ↻ back to the start
const LOOP_PINGPONG_GLYPH='<path d="M4 9h16"/><path d="M17 6l3 3-3 3"/><path d="M20 15H4"/><path d="M7 12l-3 3 3 3"/>';  // ⇄ there and back
function syncLoopUI(){
  const mode = loopMode();
  const looping = mode !== 'off';
  document.querySelectorAll('#loopSeg button').forEach(b=>b.classList.toggle('on', b.dataset.loop===mode));
  document.body.dataset.loop = mode;          // drives .loop-badge visibility (see body[data-loop])
  const badge=$('goLoopBadge');
  if(badge){
    badge.innerHTML = looping
      ? '<svg viewBox="0 0 24 24">'+(mode==='pingpong'?LOOP_PINGPONG_GLYPH:LOOP_RESTART_GLYPH)+'</svg>'
      : '';
  }
  // The sub-line has room for one more reading, not two: while a loop is armed the
  // mode is the thing you can't get anywhere else with the deck down, so it takes
  // the elapsed slot. Elapsed keeps ticking underneath and comes straight back.
  const el=$('liveElapsedWrap'), lw=$('liveLoopWrap');
  if(el && lw){
    el.hidden = looping;
    lw.hidden = !looping;
    if(looping){
      // field.loop is Title-case for the deck label; this row is lowercase
      // (seg / emit / elapsed), so case it down the way renderRoutesList does.
      $('liveLoopLabel').textContent = t('field.loop').toLowerCase();
      $('liveLoop').textContent = t('loop.'+mode);
    }
  }
}

/* ---------- waypoint long-press menu (dwell / per-leg speed / remove) ---------- */
let wpMenuIdx=-1;
function openWpMenu(i){
  if(i<0||i>=S.waypoints.length) return;
  wpMenuIdx=i; const wp=S.waypoints[i];   // every waypoint is editable — always show the full menu
  $('wpmTitle').textContent='· '+wpLabel(i);
  document.querySelectorAll('#wpmDwellSeg button').forEach(b=>b.classList.toggle('on', b.dataset.d===(wp.dwell||'none')));
  $('wpmMin').disabled = (wp.dwell!=='timed'); $('wpmMin').value = wp.dwellMin||2;
  $('wpmSpeed').value = (wp.legSpeed!=null)?wp.legSpeed:'';
  $('wpMenu').hidden=false;
}
function closeWpMenu(){ $('wpMenu').hidden=true; wpMenuIdx=-1; }
function pushWpEdit(){
  const i=wpMenuIdx; if(i<0) return; const wp=S.waypoints[i];
  if(S.gpsOn && isNative){
    FakeGps.setWaypoint({index:i, dwell:wp.dwell||'none', dwellMs:Math.round((wp.dwellMin||0)*60000),
      legSpeedKmh:(wp.legSpeed!=null)?wp.legSpeed:-1}).catch(()=>{});
  }
  persist();
}
$('wpmClose').onclick=closeWpMenu;
$('wpMenu').onclick=e=>{ if(e.target.id==='wpMenu') closeWpMenu(); };          // tap backdrop closes
$('wpmDwellSeg').onclick=e=>{ const b=e.target.closest('button'); if(!b||wpMenuIdx<0)return;
  S.waypoints[wpMenuIdx].dwell=b.dataset.d;
  document.querySelectorAll('#wpmDwellSeg button').forEach(x=>x.classList.toggle('on',x===b));
  $('wpmMin').disabled = b.dataset.d!=='timed';
  pushWpEdit(); };
$('wpmMin').oninput=()=>{ if(wpMenuIdx<0)return; S.waypoints[wpMenuIdx].dwellMin=Math.max(1,+$('wpmMin').value||1); pushWpEdit(); };
$('wpmSpeed').oninput=()=>{ if(wpMenuIdx<0)return; const v=+$('wpmSpeed').value; S.waypoints[wpMenuIdx].legSpeed=(v>0)?v:null; pushWpEdit(); };
$('wpmRemove').onclick=()=>{ const i=wpMenuIdx; closeWpMenu(); if(i>=0) removeWaypoint(i); };

/* ---------- hint ---------- */
let hintTimer;
function flashHint(msg){ const h=$('hint'); h.textContent=msg; h.style.opacity='1'; clearTimeout(hintTimer); hintTimer=setTimeout(refreshHint,2200); }

/* ---------- error toast ----------
   The loud counterpart to flashHint, and the general error channel for the whole app:
   pass any already-translated string (like flashHint, callers pass t('key')). Errors get
   red + a warning icon + motion because the neutral hint pill was too easy to miss.
   Auto-dismisses after 4s, or immediately when tapped. */
const ERROR_TOAST_MS = 4000;
let errorTimer;
function hideError(){ clearTimeout(errorTimer); $('errorToast').classList.remove('show'); }
function flashError(msg){
  const el = $('errorToast');
  $('errorToastMsg').textContent = msg;
  clearTimeout(errorTimer);
  // Restart the entrance animation on a repeat error — re-adding the class alone would
  // not replay it while the node is already showing.
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  errorTimer = setTimeout(hideError, ERROR_TOAST_MS);
}
$('errorToast').onclick = hideError;
// the empty-state hint floats above the map (high z-index); any full-screen sheet must win.
function anyOverlayOpen(){ return !!document.querySelector('#help.show,#routes.show,#setup.show,#devhelp.show,#mockhelp.show'); }
function showHint(){ if(anyOverlayOpen()) return; const h=$('hint'); h.textContent=t('hint.tapMap'); h.style.opacity='1'; }
function hideHint(){ clearTimeout(hintTimer); $('hint').style.opacity='0'; }
// the empty-state "tap the map" hint is driven purely by state: shown whenever the route is empty
function refreshHint(){ if(S.waypoints.length===0) showHint(); else hideHint(); }

/* ---------- persistence ---------- */
function persist(){
  try{
    localStorage.setItem('routeSpoofer', JSON.stringify({
      waypoints:S.waypoints, speed:S.speed, mode:S.mode, rateMs:S.rateMs, loop:S.loop
    }));
  }catch(e){}
}
let persistTimer=null;
function persistSoon(){
  clearTimeout(persistTimer); persistTimer=setTimeout(persist, 100);
}
function restore(){
  try{
    const d=JSON.parse(localStorage.getItem('routeSpoofer')||'null'); if(!d)return;
    S.mode = (d.mode && speedModes[d.mode]) ? d.mode : nearestMode(nz(d.speed, modeKmh('walk')));
    S.speed = modeKmh(S.mode);
    paintSpeedUI();
    S.rateMs=nz(d.rateMs,1000); S.loop=nz(d.loop,'off');
    $('rate').value=S.rateMs/1000; $('rateVal').textContent=(S.rateMs/1000).toFixed(1)+' s'; $('liveRate').textContent=(S.rateMs/1000).toFixed(1)+'s';
    syncLoopUI();
    if(Array.isArray(d.waypoints)&&d.waypoints.length){
      // validate every point the same way the import path does — localStorage can
      // get corrupted by a bad restore, an older version, or a manual edit.
      S.waypoints=d.waypoints.filter(validPoint).map(p=>({
        lat:+p.lat, lng:+p.lng, dwell:p.dwell||'none',
        dwellMin:p.dwellMin||2, legSpeed:(p.legSpeed!=null)?p.legSpeed:null
      }));
      refreshMarkers(); recompute();
      if(!mapViewRestored) fitRouteOnMap(S.waypoints.map(p=>[p.lat,p.lng]), false);
      hideHint();
    }
  }catch(e){}
}

function getCSS(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

/* =====================================================================
   Readiness / setup overlay (native only)
   ===================================================================== */
let lastReady=null;
async function refreshReady(){
  if(!isNative || !FakeGps){ return { ready:true, locationPermission:true, notificationPermission:true, mockAppEnabled:true, devOptionsEnabled:true }; }
  try{ lastReady = await FakeGps.ensureReady(); }
  catch(e){ console.warn('ensureReady failed',e); lastReady={ ready:false, locationPermission:false, notificationPermission:false, mockAppEnabled:false, devOptionsEnabled:true }; }
  paintReady(lastReady);
  // If dev options came back on while the helper was open, drop it and continue setup.
  if(lastReady.devOptionsEnabled && $('devhelp').classList.contains('show')) closeDevHelp();
  return lastReady;
}
function paintReady(st){
  const permOk = !!(st.locationPermission && st.notificationPermission);
  const mockOk = !!st.mockAppEnabled;
  const cp=$('chkPerm'), cm=$('chkMock');
  cp.className='check '+(permOk?'ok':'bad'); cp.querySelector('.ic').textContent=permOk?'✓':'1';
  // keep the 'tappable' affordance — chkMock opens the step-2 instructions
  cm.className='check tappable '+(mockOk?'ok':'bad'); cm.querySelector('.ic').textContent=mockOk?'✓':'2';
  // FIX 1 — the primary (yellow) accent follows the two readiness flags, so the
  // styled "next step" is always the one that actually does something.
  const bg=$('btnGrant'), bd=$('btnDev');
  if(bg && bd){
    bg.classList.remove('primary','granted'); bd.classList.remove('primary'); bg.disabled=false;
    if(!permOk){                       // step 1 outstanding → granting is the action
      bg.classList.add('primary'); bg.textContent=t('setup.grant');
    } else {                           // permissions already granted — keep the button visible but inert
      bg.disabled=true; bg.classList.add('granted'); bg.textContent='✓ '+t('setup.granted');
      if(!mockOk) bd.classList.add('primary');   // selecting the mock app is the real next step
    }
    // both satisfied → nothing left to do here; close the gate automatically
    if(permOk && mockOk && $('setup').classList.contains('show')){ closeSetup(); flashHint(t('hint.ready')); }
  }
}
function openSetup(){ refreshReady(); $('setup').classList.add('show'); hideHint(); }
function closeSetup(){ $('setup').classList.remove('show'); refreshHint(); }
function openDevHelp(){ $('devhelp').classList.add('show'); hideHint(); }
function closeDevHelp(){ $('devhelp').classList.remove('show'); refreshHint(); }

/* ---- shared step-2 ("Select mock location app") instructions ----
   Cloned from #mockStepsTpl into BOTH the info "?" page and the step-2 modal,
   so the two render from one source. applyI18n() translates the clones. */
function renderMockSteps(){
  const tpl=document.getElementById('mockStepsTpl'); if(!tpl) return;
  ['mockHelpSteps','helpMockSteps'].forEach(id=>{
    const el=$(id); if(el && !el.childElementCount) el.appendChild(tpl.content.cloneNode(true));
  });
}
function openMockHelp(){ renderMockSteps(); $('mockhelp').classList.add('show'); hideHint(); }
function closeMockHelp(){ $('mockhelp').classList.remove('show'); refreshHint(); }

/* ---- small UI helpers for Re-check feedback (FIX 3) ---- */
const delay = ms => new Promise(r=>setTimeout(r,ms));
function setChecking(btn, on){
  if(!btn) return;
  if(on){ btn._wasDisabled=btn.disabled; btn.disabled=true; btn.classList.add('is-checking'); }
  else { btn.classList.remove('is-checking'); btn.disabled=!!btn._wasDisabled; }
}
function showMsg(id, text){
  const el=$(id); if(!el || !text) return;
  clearTimeout(el._t); clearTimeout(el._th);
  el.textContent=text; el.hidden=false; el.style.opacity='1';
  el._t=setTimeout(()=>{ el.style.opacity='0'; el._th=setTimeout(()=>{ el.hidden=true; }, 220); }, 4200);
}
function pendingMsg(st){
  if(!st) return t('setup.stillChecking');
  if(!(st.locationPermission && st.notificationPermission)) return t('setup.pendingPerm');
  if(!st.mockAppEnabled) return t('setup.pendingMock');
  return '';
}

$('btnGrant').onclick=async ()=>{ if(FakeGps){ try{ await FakeGps.requestPermissions(); }catch(e){ console.warn(e);} } await refreshReady(); };
async function openDevSettingsGuided(){
  if(!FakeGps) return;
  // Only fire the dev-settings intent if Developer options are actually on —
  // otherwise Android shows a dead-end system toast. Guide the user instead.
  let on=true;
  try{ const r=await FakeGps.isDevOptionsEnabled(); on=!!(r&&r.enabled); }
  catch(e){ console.warn(e); on = lastReady ? lastReady.devOptionsEnabled!==false : true; }
  if(on){ try{ await FakeGps.openDevSettings(); }catch(e){ console.warn(e);} }
  else openDevHelp();
}
$('btnDev').onclick=openDevSettingsGuided;
$('btnRecheck').onclick=async (e)=>{
  const btn=e.currentTarget; setChecking(btn,true);
  const [st]=await Promise.all([ refreshReady(), delay(380) ]);   // brief, visible checking state
  setChecking(btn,false);
  if(st && st.ready){ closeSetup(); flashHint(t('hint.ready')); }
  else showMsg('setupMsg', pendingMsg(st));                       // never a silent no-op
};
$('btnDismiss').onclick=closeSetup;
$('btnAbout').onclick=async ()=>{ if(FakeGps){ try{ await FakeGps.openAboutPhone(); }catch(e){ console.warn(e);} } };
$('btnDevRecheck').onclick=async (e)=>{
  const btn=e.currentTarget; setChecking(btn,true);
  const [st]=await Promise.all([ refreshReady(), delay(380) ]);
  setChecking(btn,false);
  if(st && st.devOptionsEnabled){ closeDevHelp(); flashHint(t('hint.devOn')); }
  else showMsg('devMsg', t('hint.devStillOff'));
};
$('btnDevClose').onclick=closeDevHelp;

/* step-2 instruction modal wiring */
$('chkMock').onclick=openMockHelp;
$('chkMock').addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openMockHelp(); } });
$('btnMockDev').onclick=openDevSettingsGuided;
$('btnMockClose').onclick=closeMockHelp;
$('mockhelp').onclick=e=>{ if(e.target.id==='mockhelp') closeMockHelp(); };
$('btnMockRecheck').onclick=async (e)=>{
  const btn=e.currentTarget; setChecking(btn,true);
  const [st]=await Promise.all([ refreshReady(), delay(380) ]);
  setChecking(btn,false);
  if(st && st.mockAppEnabled){
    closeMockHelp();
    if(st.ready){ closeSetup(); flashHint(t('hint.ready')); }
    else showMsg('setupMsg', pendingMsg(st));
  } else {
    showMsg('mockMsg', t('mock.pending'));
  }
};

/* ---- FIX 5: re-validate on resume; revoked permission re-shows the gate ---- */
let _lastResumeCheck=0;
async function revalidateOnResume(){
  if(!isNative || !FakeGps) return;
  const now=Date.now();
  if(now-_lastResumeCheck < 800) return;   // debounce duplicate visibility/focus signals
  _lastResumeCheck=now;
  drainOpenedRouteFile();   // an "Open with" on a route file resumes us — take it first
  const st=await refreshReady();           // fast: reads permission/settings flags, no GPS fix
  if(!st) return;
  const permOk = st.locationPermission && st.notificationPermission;
  if(!permOk && !$('setup').classList.contains('show')) openSetup();   // revoked while away → same gate as first launch
}
function onAppResume(){ revalidateOnResume(); checkForAppUpdate(); }
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible') onAppResume(); });
window.addEventListener('focus', onAppResume);

/* ---------- language switcher + GitHub link ---------- */
$('langSel').onchange = e => setLang(e.target.value);
$('btnGithub').onclick = openGithub;
// Safety net for every external <a> (QA credit, Leaflet map attribution, any
// future link): intercept in the capture phase and route through the guarded
// opener, so a missing/disabled browser can never crash the WebView.
document.addEventListener('click', e=>{
  const a = (e.target && e.target.closest) ? e.target.closest('a[href]') : null;
  if(!a) return;
  const href = a.getAttribute('href') || '';
  if(/^https?:\/\//i.test(href)){ e.preventDefault(); e.stopPropagation(); openExternal(href); }
}, true);

/* ---------- help / legend modal (button-only; never auto-shown) ---------- */
function openHelp(){ $('help').classList.add('show'); hideHint(); }
function closeHelp(){ $('help').classList.remove('show'); refreshHint(); }
$('btnHelp').onclick = openHelp;
$('helpClose').onclick = closeHelp;
$('help').onclick = e => { if(e.target.id==='help') closeHelp(); };   // tap backdrop closes
// #4528: deep-link to the system screen where this app is picked as the mock
// location app (Android Developer options). The native intent is ActivityNotFound-
// guarded in Kotlin with a general-Settings fallback; if nothing can open we keep
// the dialog and show an in-app hint instead of a dead close.
async function openLocationSettings(){
  if(isNative && FakeGps && FakeGps.openDevSettings){
    try{
      const r = await FakeGps.openDevSettings();
      if(r && r.opened){ closeHelp(); return; }   // settings opened — closing the help dialog is fine
    }catch(e){ console.warn('openDevSettings failed', e); }
  }
  showMsg('helpSetupMsg', t('hint.openSettingsManual'));   // never a silent/dead close
}
$('helpOpenSetup').onclick = openLocationSettings;

/* ---------- collapsible control deck ---------- */
const DECK_KEY = 'rsDeckCollapsed';
function setDeckCollapsed(collapsed, save){
  document.body.classList.toggle('deck-collapsed', collapsed);
  $('deckGrab').setAttribute('aria-expanded', String(!collapsed));
  if(save!==false){ try{ localStorage.setItem(DECK_KEY, collapsed ? '1' : '0'); }catch(e){} }
  setTimeout(()=>{ try{ map.invalidateSize(); }catch(e){} syncAttributionInset(); }, 300);   // give the map its reclaimed space
}
/* The map fills the whole screen and the deck paints over its bottom edge, which hid
   the (legally required) attribution. Lift Leaflet's bottom corners to sit right on
   top of the deck. offsetHeight already includes the deck's safe-area bottom padding
   and ignores the search-mode slide-away transform. ResizeObserver is Chrome 64+, so
   older WebViews fall back to the toggle timer, the fold transition, the log
   <details> toggle and window resize. */
function syncAttributionInset(){
  const deck=$('deck'); if(!deck) return;
  const h=deck.offsetHeight;
  // Leaflet attribution
  document.querySelectorAll('#map .leaflet-bottom').forEach(el=>{ el.style.bottom=h+'px'; });
  // AMap SDK attribution (amap-copyright + amap-logo float at the bottom)
  document.querySelectorAll('#map .amap-copyright, #map .amap-logo').forEach(el=>{ el.style.bottom=h+'px'; });
  // the update banner stacks above whatever attribution is visible
  const ub=$('updBanner');
  const attr = document.querySelector('#map .leaflet-control-attribution')
            || document.querySelector('#map .amap-copyright');
  if(ub) ub.style.bottom=(h+(attr?attr.offsetHeight:0)+8)+'px';
}
if(typeof ResizeObserver==='function'){ new ResizeObserver(syncAttributionInset).observe($('deck')); }
else {
  $('deckBody').addEventListener('transitionend', syncAttributionInset);
  $('deck').addEventListener('toggle', syncAttributionInset, true);   // <details> toggle doesn't bubble
}
window.addEventListener('resize', syncAttributionInset);
syncAttributionInset();
$('deckGrab').onclick = () => setDeckCollapsed(!document.body.classList.contains('deck-collapsed'));
(function(){                       // vertical swipe on the handle toggles too
  let y0 = null; const g = $('deckGrab');
  g.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; }, {passive:true});
  g.addEventListener('touchend', e => {
    if(y0==null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null;
    if(dy < -24) setDeckCollapsed(false); else if(dy > 24) setDeckCollapsed(true);
  });
})();

/* ---------- place / address search ----------
   Three sources, priority-ordered:
     1. AMap JS SDK  PlaceSearch + Geocoder  — when USING_AMAP (no REST key needed)
     2. AMap Web Service API (restapi.amap.com) — when AMAP_WEB_KEY is set  (Leaflet fallback path)
     3. Nominatim (OSM) — always available as last resort
   AMap answers in GCJ-02; the result is converted to WGS-84 before it reaches
   the route/map state (which always works in WGS-84). */
const AMAP_WEB_KEY = (function(){ try{ return (localStorage.getItem('amapWebKey') || '').trim(); }catch(e){ return ''; } })();
const geocode = (function(){
  let timer = null, inflight = false;
  // --- Leaflet-fallback REST helpers (Web Service API + Nominatim) ---
  const AMAP_GEO = 'https://restapi.amap.com/v3/geocode/geo';
  const AMAP_POI = 'https://restapi.amap.com/v3/place/text';
  function amapHit(obj){
    if(!obj || !obj.location) return null;
    const p = String(obj.location).split(',');
    if(p.length !== 2) return null;
    const w = GCJ.gcj2wgs(+p[1], +p[0]);
    return [w[0], w[1]];
  }
  async function viaAmapRest(q){
    const key = '?key=' + encodeURIComponent(AMAP_WEB_KEY) + '&output=JSON';
    const urls = [
      AMAP_GEO + key + '&address=' + encodeURIComponent(q),
      AMAP_POI + key + '&offset=1&page=1&extensions=base&keywords=' + encodeURIComponent(q),
    ];
    for(const url of urls){
      const res = await fetch(url);
      const data = await res.json();
      if(data && data.status === '1'){
        const hit = amapHit((data.geocodes && data.geocodes[0]) || (data.pois && data.pois[0]));
        if(hit) return hit;
      }
    }
    return null;
  }
  async function viaNominatim(q){
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language='
      + encodeURIComponent(curLang||'en') + '&q=' + encodeURIComponent(q);
    const res = await fetch(url, { headers:{ 'Accept':'application/json' } });
    const data = await res.json();
    return (Array.isArray(data) && data.length) ? [+data[0].lat, +data[0].lon] : null;
  }
  // --- AMap JS SDK mode (preferred, no REST key) ---
  function viaAmapSdk(q){
    return new Promise((resolve, reject) => {
      const search = new AMap.PlaceSearch({ extensions:'base', pageSize:1, pageIndex:1 });
      search.search(q, (status, result) => {
        if(status === 'complete' && result.poiList && result.poiList.pois && result.poiList.pois.length){
          const p = result.poiList.pois[0].location;   // AMap Poi has LatLng .lat .lng (GCJ-02)
          const w = USING_AMAP
            ? [fromMapLL({ lat:p.getLat(), lng:p.getLng() }).lat, fromMapLL({ lat:p.getLat(), lng:p.getLng() }).lng]
            : GCJ.gcj2wgs(p.getLat(), p.getLng());
          resolve(w);
        } else {
          const geo = new AMap.Geocoder();
          geo.getLocation(q, (status2, result2) => {
            if(status2 === 'complete' && result2.geocodes && result2.geocodes.length){
              const g = result2.geocodes[0].location;   // AMap Geocode location is also LatLng (GCJ-02)
              const w = GCJ.gcj2wgs(g.getLat(), g.getLng());
              resolve(w);
            } else reject(new Error('no hit'));
          });
        }
      });
    });
  }
  // --- orchestrator ---
  async function run(q){
    if(!q || inflight) return;
    inflight = true; $('searchBar').classList.add('busy'); flashHint(t('search.searching'));
    try{
      let hit = null;
      if(USING_AMAP && window.AMap){ try{ hit = await viaAmapSdk(q); }catch(e){ console.warn('[search] AMap SDK failed', e); } }
      if(!hit && AMAP_WEB_KEY){ try{ hit = await viaAmapRest(q); }catch(e){ console.warn('[search] AMap REST failed', e); } }
      if(!hit) hit = await viaNominatim(q);
      if(hit){ centerOnMap(hit, 13, true); hideHint(); }
      else flashHint(t('search.notFound'));
    }catch(e){ flashHint(t('search.error')); }
    finally{ inflight = false; $('searchBar').classList.remove('busy'); }
  }
  return q => { clearTimeout(timer); timer = setTimeout(()=>run(q.trim()), 350); };   // debounced
})();
$('searchBar').addEventListener('submit', e => { e.preventDefault(); geocode($('searchInput').value); $('searchInput').blur(); });
// keyboard-up layout: while the search field is focused, slide the deck away (see .searching CSS)
$('searchInput').addEventListener('focus', () => document.body.classList.add('searching'));
$('searchInput').addEventListener('blur',  () => document.body.classList.remove('searching'));

/* ---------- saved routes (presets) ---------- */
const ROUTES_KEY = 'rsRoutes', ROUTES_CAP = 50, ROUTES_WRAP = { app:'route-spoofer', type:'routes', version:1 };
const routeSel = new Set();
function rid(){ return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function normRoute(r){
  return { id:r.id||rid(), name:String(r.name||'Route'),
    waypoints:Array.isArray(r.waypoints)?r.waypoints:[], speed:nz(r.speed,40), rateMs:nz(r.rateMs,1000), loop:r.loop||'off' };
}
function loadRoutes(){ try{ const a=JSON.parse(localStorage.getItem(ROUTES_KEY)||'[]'); return Array.isArray(a)?a.map(normRoute):[]; }catch(e){ return []; } }
function saveRoutes(a){ try{ localStorage.setItem(ROUTES_KEY, JSON.stringify(a)); }catch(e){} }
function uniqueName(name, taken){ const set=new Set(taken); if(!set.has(name)) return name; let i=2; while(set.has(name+' ('+i+')')) i++; return name+' ('+i+')'; }
/* A point is usable only if it is a real position on the globe: finite AND in range.
   isFinite alone let lat:999 through, which lands the route nowhere on the map. */
function validPoint(p){
  if(!p) return false;
  const lat=+p.lat, lng=+p.lng;
  return isFinite(lat) && isFinite(lng) && lat>=-90 && lat<=90 && lng>=-180 && lng<=180;
}
function normWaypoint(p){
  return { lat:+p.lat, lng:+p.lng, dwell:p.dwell||'none', dwellMin:p.dwellMin||2, legSpeed:(p.legSpeed!=null)?+p.legSpeed:null };
}
function cleanWaypoints(arr){
  return (Array.isArray(arr)?arr:[]).filter(validPoint).map(normWaypoint);
}
/* Strict variant for IMPORT: the whole file is rejected if any point is bad, rather than
   quietly dropping it — a route silently missing a stop is worse than a refused import.
   Returns null when the list is missing, empty, or holds a single invalid point. */
function importWaypoints(arr){
  if(!Array.isArray(arr) || !arr.length) return null;
  for(let i=0;i<arr.length;i++) if(!validPoint(arr[i])) return null;
  return arr.map(normWaypoint);
}

function saveCurrentRoute(){
  if(S.waypoints.length<1){ flashHint(t('routes.needPoints')); return; }
  const a=loadRoutes();
  if(a.length>=ROUTES_CAP){ flashError(t('routes.full')); return; }
  const typed=(prompt(t('routes.namePrompt'),'')||'').trim(); if(!typed) return;
  a.push({ id:rid(), name:uniqueName(typed, a.map(r=>r.name)),
    waypoints:cleanWaypoints(S.waypoints), speed:S.speed, rateMs:S.rateMs, loop:S.loop });
  saveRoutes(a); renderRoutesList(); flashHint(t('routes.saved'));
}
function loadRouteIntoScene(rt){      // restore full scene, reset to idle, recenter to its bounds
  if(S.gpsOn) gpsTurnOff();
  S.waypoints = cleanWaypoints(rt.waypoints);
  S.mode = nearestMode(nz(rt.speed, modeKmh('walk')));
  S.speed = modeKmh(S.mode); paintSpeedUI();
  S.rateMs = nz(rt.rateMs,1000); S.loop = rt.loop||'off';
  S.traveled = 0; S.phase = 'standing';
  $('rate').value=S.rateMs/1000; $('rateVal').textContent=(S.rateMs/1000).toFixed(1)+' s'; $('liveRate').textContent=(S.rateMs/1000).toFixed(1)+'s';
  syncLoopUI();
  document.body.dataset.gps='off'; document.body.dataset.phase='standing';
  if(S.emitMarker){ S.emitMarker.remove(); S.emitMarker=null; }
  document.getElementById('stateLabel').textContent=statusText();
  document.getElementById('railFill').style.width='0%';
  document.getElementById('liveElapsed').textContent='00:00';
  refreshMarkers(); recompute(); renderLiveCoord(sampleAt(0));
  if(S.waypoints.length){ fitRouteOnMap(S.waypoints.map(p=>[p.lat,p.lng]), true); hideHint(); }  // overrides the remembered view
  syncTools(); persist();
}
function deleteRoutes(ids){ const set=new Set(ids); saveRoutes(loadRoutes().filter(r=>!set.has(r.id))); ids.forEach(id=>routeSel.delete(id)); renderRoutesList(); }
function renameRoute(id){
  const a=loadRoutes(); const r=a.find(x=>x.id===id); if(!r) return;
  const nn=(prompt(t('routes.renamePrompt'), r.name)||'').trim(); if(!nn) return;
  r.name=uniqueName(nn, a.filter(x=>x.id!==id).map(x=>x.name)); saveRoutes(a); renderRoutesList();
}
function routeSlug(s){ return (String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')||'route').slice(0,40); }
async function exportRoutes(routes){
  const payload=Object.assign({}, ROUTES_WRAP, { routes:routes.map(r=>({ name:r.name, waypoints:r.waypoints, speed:r.speed, rateMs:r.rateMs, loop:r.loop })) });
  const text=JSON.stringify(payload,null,2);
  const fname = routes.length===1 ? ('route-'+routeSlug(routes[0].name)+'.json') : 'route-spoofer-routes.json';
  // Native: <a download> silently no-ops in the Android WebView — write a file and open the share sheet.
  if(isNative && Filesystem && Share){
    try{
      await Filesystem.writeFile({ path:fname, data:text, directory:'CACHE', encoding:'utf8' });
      const { uri } = await Filesystem.getUri({ path:fname, directory:'CACHE' });
      await Share.share({ title:t('routes.title'), url:uri, dialogTitle:t('routes.shareTitle') });
      flashHint(t('routes.exported'));
    }catch(e){ console.warn('native export failed', e); flashError(t('routes.exportErr')); }
    return;
  }
  // Web fallback: Blob + <a download>
  try{
    const blob=new Blob([text],{type:'application/json'});
    const url=URL.createObjectURL(blob); const a=document.createElement('a');
    a.href=url; a.download=fname; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
    flashHint(t('routes.exported'));
  }catch(e){ console.warn('export failed', e); flashError(t('routes.exportErr')); }
}
/* Route file the app was opened with ("Open with" / share sheet on an exported .json).
   The native side parked it (RouteImport); drain it at boot and on every resume, since
   a file opened while the app is already running arrives via onNewIntent. */
async function drainOpenedRouteFile(){
  if(!isNative || !FakeGps || !FakeGps.consumePendingImport) return;
  let res;
  try{ res = await FakeGps.consumePendingImport(); }
  catch(e){ console.warn('pending import failed', e); flashError(t('routes.importBad')); return; }
  const txt = res && res.data;
  const err = res && res.error;
  // A file WAS opened but the native side couldn't read it (unreadable / empty / oversized).
  // Say so — staying silent here made a failed open look like a normal launch.
  if(!txt){ if(err) flashError(t('routes.importBad')); return; }   // no data, no error = normal launch
  const before = loadRoutes().length;
  importRoutesFromText(String(txt));              // reports the outcome in the hint itself
  if(loadRoutes().length > before) openRoutes();  // land on the list holding the new route
}
/* All-or-nothing import. Every malformed input — bad JSON, wrong shape, a route with no
   points, a single out-of-range coordinate — rejects the WHOLE file under one message.
   The old code half-imported such files and still reported success ("Imported 0, skipped
   1"), which read as though it had worked. Shared by the "Open with" and file-picker paths. */
function importRoutesFromText(txt){
  let parsed; try{ parsed=JSON.parse(txt); }catch(e){ flashError(t('routes.importBad')); return; }
  let incoming;
  if(parsed && Array.isArray(parsed.routes)) incoming=parsed.routes;          // unified wrapper
  else if(Array.isArray(parsed)) incoming=parsed;                             // bare list
  else if(parsed && Array.isArray(parsed.waypoints)) incoming=[parsed];       // single route object
  else { flashError(t('routes.importBad')); return; }
  if(!incoming.length){ flashError(t('routes.importBad')); return; }            // nothing to import
  // Validate everything BEFORE touching storage: one bad point rejects the file.
  const staged=[];
  for(const raw of incoming){
    const wps = raw ? importWaypoints(raw.waypoints) : null;
    if(!wps){ flashError(t('routes.importBad')); return; }
    staged.push({ raw:raw, waypoints:wps });
  }
  const a=loadRoutes();
  // A valid file that simply doesn't fit keeps its own message — the file is fine, the shelf is full.
  if(a.length + staged.length > ROUTES_CAP){ flashError(t('routes.full')); return; }
  for(const s of staged){
    a.push({ id:rid(), name:uniqueName((String(s.raw.name||'Route').trim())||'Route', a.map(r=>r.name)),
      waypoints:s.waypoints, speed:nz(s.raw.speed,40), rateMs:nz(s.raw.rateMs,1000), loop:s.raw.loop||'off' });
  }
  saveRoutes(a); renderRoutesList();
  flashHint(t('routes.importDone').replace('{a}',staged.length).replace('{b}',0));
}
function updateRoutesBar(){
  const all=loadRoutes(), n=routeSel.size;
  $('rtCount').textContent = n + ' ' + t('routes.selected');
  $('rtSelAll').textContent = (all.length>0 && n>=all.length) ? t('routes.clearSel') : t('routes.selectAll');
  $('rtExportSel').disabled = n<1; $('rtDelSel').disabled = n<1;
  $('rtExportAll').disabled = all.length===0;   // nothing to export when empty (#4535)
}
function renderRoutesList(){
  const all=loadRoutes(); for(const id of [...routeSel]) if(!all.some(r=>r.id===id)) routeSel.delete(id);
  const q=$('rtSearch').value.trim().toLowerCase();
  const list = q ? all.filter(r=>r.name.toLowerCase().includes(q)) : all;
  const box=$('rtList'); box.innerHTML='';
  if(!all.length){ const p=document.createElement('p'); p.className='rt-empty'; p.textContent=t('routes.empty'); box.appendChild(p); }
  else if(!list.length){ const p=document.createElement('p'); p.className='rt-empty'; p.textContent=t('routes.noMatch'); box.appendChild(p); }
  else list.forEach(r=>{
    const row=document.createElement('div'); row.className='rt-row';
    const cb=document.createElement('input'); cb.type='checkbox'; cb.className='rt-cb'; cb.checked=routeSel.has(r.id);
    cb.onclick=e=>{ e.stopPropagation(); if(cb.checked) routeSel.add(r.id); else routeSel.delete(r.id); updateRoutesBar(); };
    const nm=document.createElement('button'); nm.type='button'; nm.className='rt-name';
    nm.innerHTML='<b>'+escapeHtml(r.name)+'</b><span>'+r.waypoints.length+' · '+(+r.speed.toFixed(1))+' km/h · '+t('field.loop').toLowerCase()+' '+escapeHtml(r.loop)+'</span>';
    nm.onclick=()=>{ loadRouteIntoScene(r); closeRoutes(); flashHint(t('routes.loaded')); };
    const ren=document.createElement('button'); ren.type='button'; ren.className='rt-act'; ren.textContent=t('routes.rename');
    ren.onclick=e=>{ e.stopPropagation(); renameRoute(r.id); };
    const del=document.createElement('button'); del.type='button'; del.className='rt-act danger'; del.textContent=t('routes.delete');
    del.onclick=e=>{ e.stopPropagation(); if(confirm(t('routes.confirmDelete'))) deleteRoutes([r.id]); };
    row.append(cb, nm, ren, del); box.appendChild(row);
  });
  updateRoutesBar();
}
function openRoutes(){ routeSel.clear(); $('rtSearch').value=''; $('rtSave').disabled = S.waypoints.length<1; renderRoutesList(); $('routes').classList.add('show'); hideHint(); }
function closeRoutes(){ $('routes').classList.remove('show'); refreshHint(); }
$('btnRoutes').onclick = openRoutes;
$('rtClose').onclick = closeRoutes;
$('routes').onclick = e => { if(e.target.id==='routes') closeRoutes(); };
$('rtSearch').oninput = renderRoutesList;
$('rtSave').onclick = saveCurrentRoute;
$('rtSelAll').onclick = () => { const all=loadRoutes(); if(all.length>0 && routeSel.size>=all.length){ routeSel.clear(); } else { all.forEach(r=>routeSel.add(r.id)); } renderRoutesList(); };
$('rtDelSel').onclick = () => { if(!routeSel.size) return; if(confirm(t('routes.confirmDelSel'))) deleteRoutes([...routeSel]); };
$('rtExportSel').onclick = () => { const sel=loadRoutes().filter(r=>routeSel.has(r.id)); if(!sel.length){ flashHint(t('routes.noneSelected')); return; } exportRoutes(sel); };
$('rtExportAll').onclick = () => { const all=loadRoutes(); if(!all.length) return; exportRoutes(all); };   // button is disabled when empty (#4535)
$('rtDeleteAll').onclick = () => { if(!loadRoutes().length) return; if(confirm(t('routes.confirmDelAll'))){ saveRoutes([]); routeSel.clear(); renderRoutesList(); } };
$('rtImport').onclick = () => $('rtFile').click();
$('rtFile').onchange = e => {
  const f=e.target.files && e.target.files[0]; if(!f){ return; }
  const rd=new FileReader();
  rd.onload = () => { importRoutesFromText(String(rd.result)); $('rtFile').value=''; };
  rd.onerror = () => { flashError(t('routes.importBad')); $('rtFile').value=''; };
  rd.readAsText(f);
};

/* ---------- settings ---------- */
function paintSettings(){
  SPEED_MODE_ORDER.forEach(m=>{
    $(SPEED_FIELDS[m]).value=speedModes[m];
    $(SPEED_FIELDS[m]+'Kmh').textContent=(+(speedModes[m]*3.6).toFixed(1))+' km/h';
  });
}
function applyModeSpeed(m){
  const el=$(SPEED_FIELDS[m]); const v=parseFloat(el.value);
  if(!isFinite(v) || v<=0) return;
  const clamped=Math.min(40, Math.max(0.1, v));
  speedModes[m]=clamped; saveSpeedModes();
  if(S.mode===m){ S.speed=modeKmh(m); liveSpeed(); }
  paintSpeedUI();
  $(SPEED_FIELDS[m]+'Kmh').textContent=(+(clamped*3.6).toFixed(1))+' km/h';
}
SPEED_MODE_ORDER.forEach(m=>{
  const el=$(SPEED_FIELDS[m]);
  el.oninput=()=>applyModeSpeed(m);
  el.onchange=()=>{ el.value=speedModes[m]; };
});
function openSettings(){ paintSettings(); $('settings').classList.add('show'); hideHint(); }
function closeSettings(){ $('settings').classList.remove('show'); refreshHint(); }
$('btnSettings').onclick=openSettings;
$('stClose').onclick=closeSettings;
$('settings').onclick=e=>{ if(e.target.id==='settings') closeSettings(); };

/* ---------- GitHub release updater ----------
   The APK is distributed outside any store, so updates are pulled from the
   rolling `latest` release that CI publishes (APK + latest.json). The native
   AppUpdater plugin does the download, SHA-256 check and package install, so
   no Google Play / Play Core dependency is involved. Every failure is silent
   (console.info) — offline or blocked GitHub must never interrupt startup. */
const UPDATE_REPO = 'wusheng666/route-spoofer';
const UPDATE_API = 'https://api.github.com/repos/' + UPDATE_REPO + '/releases/tags/latest';
const UPDATE_CHECK_KEY = 'rsUpdateCheckedAt';
const UPDATE_CHECK_EVERY_MS = 6*60*60*1000;
let updInfo = null;        // manifest of the available build
let updLater = false;      // "Later" → hidden until the next app start (not resume)
let updBusy = false;
function showUpdateBanner(){
  if(updLater || !updInfo) return;
  $('updMsg').textContent = t('update.available') + ' · v' + (updInfo.versionName || '');
  $('updBanner').hidden = false;
  syncAttributionInset();
}
async function checkForAppUpdate(){
  if(!AppUpdater || updBusy) return;
  const now = Date.now();
  let last = 0;
  try{ last = +localStorage.getItem(UPDATE_CHECK_KEY) || 0; }catch(e){}
  if(last && now-last < UPDATE_CHECK_EVERY_MS) return;
  updBusy = true;
  try{
    const me = await AppUpdater.getInfo();
    // Resolve the manifest through the API so a re-uploaded asset is never
    // served from a stale release-asset cache.
    const relRes = await fetch(UPDATE_API, { cache:'no-store' });
    if(!relRes.ok) throw new Error('HTTP '+relRes.status);
    const rel = await relRes.json();
    // The manifest is the release body: GitHub serves release assets without
    // CORS headers, so a WebView cannot fetch latest.json directly. The asset is
    // still published for plain HTTP clients, hence the fallback.
    let info = null;
    try{ info = JSON.parse((rel.body || '').trim()); }catch(e){}
    if(!info || !info.url){
      const asset = (rel.assets || []).find(a=>a.name === 'latest.json');
      if(!asset) throw new Error('manifest missing');
      const res = await fetch(asset.browser_download_url, { cache:'no-store' });
      if(!res.ok) throw new Error('HTTP '+res.status);
      info = await res.json();
    }
    try{ localStorage.setItem(UPDATE_CHECK_KEY, String(now)); }catch(e){}
    if(!info || !info.url || !(info.versionCode > me.versionCode)) return;
    updInfo = info;
    showUpdateBanner();
  }catch(e){ console.info('[update] check skipped:', (e && e.message) || e); }
  finally{ updBusy = false; }
}
async function installUpdate(){
  if(!AppUpdater || !updInfo || updBusy) return;
  if(isPlaybackActive()){
    if(!confirm(t('update.confirmStop'))) return;
    pressStop();
  }
  updBusy = true;
  const btn = $('updDownload');
  btn.disabled = true;
  btn.textContent = t('update.downloading');
  try{
    await AppUpdater.downloadAndInstall({
      url: updInfo.url,
      sha256: updInfo.sha256 || '',
      versionName: updInfo.versionName || ''
    });
    // Keep the banner: if the user cancels the system installer, Download stays
    // available instead of disappearing until the next 6 h check.
  }catch(e){
    const code = (e && e.code) || '';
    if(code === 'INSTALL_PERMISSION'){
      $('updMsg').textContent = t('update.allowInstall');
      AppUpdater.openInstallSettings().catch(()=>{});
    }else if(code === 'CHECKSUM_MISMATCH'){
      $('updMsg').textContent = t('update.badFile');
    }else{
      $('updMsg').textContent = t('update.failed');
    }
    console.info('[update] install failed:', code || (e && e.message) || e);
  }finally{
    updBusy = false;
    btn.disabled = false;
    btn.textContent = t('update.download');
  }
}
if(AppUpdater){
  AppUpdater.addListener('progress', s=>{
    if(!s || updLater) return;
    $('updMsg').textContent = t('update.downloading') + ' ' + s.percent + '%';
  }).catch(()=>{});
}
$('updDownload').onclick = installUpdate;
$('updLater').onclick = () => { updLater = true; $('updBanner').hidden = true; };

/* ---------- boot ---------- */
initLang();
try{ setDeckCollapsed(localStorage.getItem(DECK_KEY)==='1', false); }catch(e){}  // apply deck state first so centering measures the real insets
mapViewRestored = restoreMapView();   // a saved view wins over the route's fit-bounds
restore();
document.body.dataset.gps='off';
document.body.dataset.phase='standing';
setGoReady();
renderMockSteps();           // clone shared step-2 instructions into both render targets…
$('setupVersion').textContent = $('appVersion').textContent;   // mirror the footer build version onto the permissions screen (single source of truth)
applyI18n();                 // …then localize the static UI (incl. those clones) before first paint
renderLiveCoord(sampleAt(0));
paintHud();
drainOpenedRouteFile();      // cold start from "Open with" on an exported route file
checkForAppUpdate();         // GitHub release check (no-op in a browser / when offline)

const chipsEl = document.querySelector('.chips');
if(chipsEl){
  chipsEl.addEventListener('scroll', updateChipFade, {passive:true});
  window.addEventListener('resize', updateChipFade);
  updateChipFade();
}
map.whenReady(refreshHint);   // show the empty-state hint once the map is ready (survives a cold start)

if(isNative && FakeGps){
  // single source of truth: native clock streams fixes back to the UI
  FakeGps.addListener('fix', applyNativeFix);
  // surface permission / mock-app guidance up front
  refreshReady().then(st=>{ if(st && !st.ready) openSetup(); });
}

/* public API the native shell (or tests) can also drive */
window.RouteSpoofer={
  gps:()=>toggleGps(),
  go:()=>pressGo(),
  stop:()=>pressStop(),
  phase:()=>S.phase, gpsOn:()=>S.gpsOn, route:()=>S.waypoints.slice()
};
