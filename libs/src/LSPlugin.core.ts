import EventEmitter from 'eventemitter3'
import {
  deepMerge,
  setupInjectedStyle,
  genID,
  setupInjectedUI,
  deferred,
  invokeHostExportedApi,
  isObject,
  withFileProtocol,
  getSDKPathRoot,
  PROTOCOL_FILE,
  URL_LSP,
  safetyPathJoin,
  path,
  safetyPathNormalize,
  mergeSettingsWithSchema,
  IS_DEV,
  cleanInjectedScripts,
  safeSnakeCase,
  injectTheme,
  cleanInjectedUI,
  PluginLogger,
} from './helpers'
import * as pluginHelpers from './helpers'
import DOMPurify from 'dompurify'
import Debug from 'debug'
import {
  LSPluginCaller,
  LSPMSG_READY,
  LSPMSG_SYNC,
  LSPMSG,
  LSPMSG_SETTINGS,
  LSPMSG_ERROR_TAG,
  LSPMSG_BEFORE_UNLOAD,
  AWAIT_LSPMSGFn,
} from './LSPlugin.caller'
import {
  ILSPluginThemeManager,
  LegacyTheme,
  LSPluginPkgConfig,
  SettingSchemaDesc,
  StyleOptions,
  StyleString,
  Theme,
  ThemeMode,
  UIContainerAttrs,
  UIOptions,
} from './LSPlugin'

const debug = Debug('LSPlugin:core')
const DIR_PLUGINS = 'plugins'

declare global {
  interface Window {
    LSPluginCore: LSPluginCore
    DOMPurify: typeof DOMPurify
  }
}

type DeferredActor = ReturnType<typeof deferred>

interface LSPluginCoreOptions {
  dotConfigRoot: string
}

/**
 * User settings
 */
class PluginSettings extends EventEmitter<'change' | 'reset'> {
  private _settings: Record<string, any> = {
    disabled: false,
  }

  constructor(
    private readonly _userPluginSettings: any,
    private _schema?: SettingSchemaDesc[]
  ) {
    super()

    Object.assign(this._settings, _userPluginSettings)
  }

  get<T = any>(k: string): T {
    return this._settings[k]
  }

  set(k: string | Record<string, any>, v?: any) {
    const o = deepMerge({}, this._settings)

    if (typeof k === 'string') {
      if (this._settings[k] == v) return
      this._settings[k] = v
    } else if (isObject(k)) {
      this._settings = deepMerge(this._settings, k)
    } else {
      return
    }

    this.emit('change', Object.assign({}, this._settings), o)
  }

  set settings(value: Record<string, any>) {
    this._settings = value
  }

  get settings(): Record<string, any> {
    return this._settings
  }

  setSchema(schema: SettingSchemaDesc[], syncSettings?: boolean) {
    this._schema = schema

    if (syncSettings) {
      const _settings = this._settings
      this._settings = mergeSettingsWithSchema(_settings, schema)
      this.emit('change', this._settings, _settings)
    }
  }

  reset() {
    const o = this.settings
    const val = {}

    if (this._schema) {
      // TODO: generated by schema
    }

    this.settings = val
    this.emit('reset', val, o)
  }

  toJSON() {
    return this._settings
  }
}

interface UserPreferences {
  theme: LegacyTheme
  themes: {
    mode: ThemeMode
    light: Theme
    dark: Theme
  }
  externals: string[] // external plugin locations
}

interface PluginLocalOptions {
  key?: string // Unique from Logseq Plugin Store
  entry: string // Plugin main file
  url: string // Plugin package absolute fs location
  name: string
  version: string
  mode: 'shadow' | 'iframe'
  settingsSchema?: SettingSchemaDesc[]
  settings?: PluginSettings
  effect?: boolean
  theme?: boolean

  [key: string]: any
}

interface PluginLocalSDKMetadata {
  version: string

  [key: string]: any
}

type PluginLocalUrl = Pick<PluginLocalOptions, 'url'> & { [key: string]: any }
type RegisterPluginOpts = PluginLocalOptions | PluginLocalUrl

type PluginLocalIdentity = string

enum PluginLocalLoadStatus {
  LOADING = 'loading',
  UNLOADING = 'unloading',
  LOADED = 'loaded',
  UNLOADED = 'unload',
  ERROR = 'error',
}

function initUserSettingsHandlers(pluginLocal: PluginLocal) {
  const _ = (label: string): any => `settings:${label}`

  // settings:schema
  pluginLocal.on(
    _('schema'),
    ({ schema, isSync }: { schema: SettingSchemaDesc[]; isSync?: boolean }) => {
      pluginLocal.settingsSchema = schema
      pluginLocal.settings?.setSchema(schema, isSync)
    }
  )

  // settings:update
  pluginLocal.on(_('update'), (attrs) => {
    if (!attrs) return
    pluginLocal.settings?.set(attrs)
  })

  // settings:visible:changed
  pluginLocal.on(_('visible:changed'), (payload) => {
    const visible = payload?.visible
    invokeHostExportedApi(
      'set_focused_settings',
      visible ? pluginLocal.id : null
    )
  })
}

function initMainUIHandlers(pluginLocal: PluginLocal) {
  const _ = (label: string): any => `main-ui:${label}`

  // main-ui:visible
  pluginLocal.on(_('visible'), ({ visible, toggle, cursor, autoFocus }) => {
    const el = pluginLocal.getMainUIContainer()
    el?.classList[toggle ? 'toggle' : visible ? 'add' : 'remove']('visible')
    // pluginLocal.caller!.callUserModel(LSPMSG, { type: _('visible'), payload: visible })
    // auto focus frame
    if (visible) {
      if (!pluginLocal.shadow && el && autoFocus !== false) {
        el.querySelector('iframe')?.contentWindow?.focus()
      }
    } else {
      // @ts-expect-error set activeElement back to `body`
      el.ownerDocument.activeElement.blur()
    }

    if (cursor) {
      invokeHostExportedApi('restore_editing_cursor')
    }
  })

  // main-ui:attrs
  pluginLocal.on(_('attrs'), (attrs: Partial<UIContainerAttrs>) => {
    const el = pluginLocal.getMainUIContainer()
    Object.entries(attrs).forEach(([k, v]) => {
      el?.setAttribute(k, String(v))
      if (k === 'draggable' && v) {
        pluginLocal._dispose(
          pluginLocal._setupDraggableContainer(el, {
            title: pluginLocal.options.name,
            close: () => {
              pluginLocal.caller.call('sys:ui:visible', { toggle: true })
            },
          })
        )
      }

      if (k === 'resizable' && v) {
        pluginLocal._dispose(pluginLocal._setupResizableContainer(el))
      }
    })
  })

  // main-ui:style
  pluginLocal.on(_('style'), (style: Record<string, any>) => {
    const el = pluginLocal.getMainUIContainer()
    const isInitedLayout = !!el.dataset.inited_layout

    Object.entries(style).forEach(([k, v]) => {
      if (
        isInitedLayout &&
        ['left', 'top', 'bottom', 'right', 'width', 'height'].includes(k)
      ) {
        return
      }

      el.style[k] = v
    })
  })
}

function initProviderHandlers(pluginLocal: PluginLocal) {
  const _ = (label: string): any => `provider:${label}`
  let themed = false

  // provider:theme
  pluginLocal.on(_('theme'), (theme: Theme) => {
    pluginLocal.themeMgr.registerTheme(pluginLocal.id, theme)

    if (!themed) {
      pluginLocal._dispose(() => {
        pluginLocal.themeMgr.unregisterTheme(pluginLocal.id)
      })

      themed = true
    }
  })

  // provider:style
  pluginLocal.on(_('style'), (style: StyleString | StyleOptions) => {
    let key: string | undefined

    if (typeof style !== 'string') {
      key = style.key
      style = style.style
    }

    if (!style || !style.trim()) return

    pluginLocal._dispose(
      setupInjectedStyle(style, {
        'data-injected-style': key ? `${key}-${pluginLocal.id}` : '',
        'data-ref': pluginLocal.id,
      })
    )
  })

  // provider:ui
  pluginLocal.on(_('ui'), (ui: UIOptions) => {
    pluginLocal._onHostMounted(() => {
      const ret = setupInjectedUI.call(
        pluginLocal,
        ui,
        Object.assign(
          {
            'data-ref': pluginLocal.id,
          },
          ui.attrs || {}
        ),
        ({ el, float }) => {
          if (!float) return
          const identity = el.dataset.identity
          pluginLocal.layoutCore.move_container_to_top(identity)
        }
      )

      if (typeof ret === 'function') {
        pluginLocal._dispose(ret)
      }
    })
  })
}

function initApiProxyHandlers(pluginLocal: PluginLocal) {
  const _ = (label: string): any => `api:${label}`

  pluginLocal.on(_('call'), async (payload) => {
    let ret: any

    try {
      ret = await invokeHostExportedApi.apply(pluginLocal, [
        payload.method,
        ...payload.args,
      ])
    } catch (e) {
      ret = {
        [LSPMSG_ERROR_TAG]: e,
      }
    }

    if (pluginLocal.shadow) {
      if (payload.actor) {
        payload.actor.resolve(ret)
      }
      return
    }

    const { _sync } = payload

    if (_sync != null) {
      const reply = (result: any) => {
        pluginLocal.caller?.callUserModel(LSPMSG_SYNC, {
          result,
          _sync,
        })
      }

      Promise.resolve(ret).then(reply, reply)
    }
  })
}

function convertToLSPResource(fullUrl: string, dotPluginRoot: string) {
  if (dotPluginRoot && fullUrl.startsWith(PROTOCOL_FILE + dotPluginRoot)) {
    fullUrl = safetyPathJoin(
      URL_LSP,
      fullUrl.substr(PROTOCOL_FILE.length + dotPluginRoot.length)
    )
  }
  return fullUrl
}

class IllegalPluginPackageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IllegalPluginPackageError'
  }
}

class ExistedImportedPluginPackageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExistedImportedPluginPackageError'
  }
}

/**
 * Host plugin for local
 */
class PluginLocal extends EventEmitter<
  'loaded' | 'unloaded' | 'beforeunload' | 'error' | string
> {
  private _sdk: Partial<PluginLocalSDKMetadata> = {}
  private _disposes: Array<() => Promise<any>> = []
  private _id: PluginLocalIdentity
  private _status: PluginLocalLoadStatus = PluginLocalLoadStatus.UNLOADED
  private _loadErr?: Error
  private _localRoot?: string
  private _dotSettingsFile?: string
  private _caller?: LSPluginCaller
  private _logger?: PluginLogger = new PluginLogger('PluginLocal')

  /**
   * @param _options
   * @param _themeMgr
   * @param _ctx
   */
  constructor(
    private _options: PluginLocalOptions,
    private readonly _themeMgr: ILSPluginThemeManager,
    private readonly _ctx: LSPluginCore
  ) {
    super()

    this._id = _options.key || genID()

    initUserSettingsHandlers(this)
    initMainUIHandlers(this)
    initProviderHandlers(this)
    initApiProxyHandlers(this)
  }

  async _setupUserSettings(reload?: boolean) {
    const { _options } = this
    const logger = (this._logger = new PluginLogger(`Loader:${this.debugTag}`))

    if (_options.settings && !reload) {
      return
    }

    try {
      const loadFreshSettings = () =>
        invokeHostExportedApi('load_plugin_user_settings', this.id)
      const [userSettingsFilePath, userSettings] = await loadFreshSettings()
      this._dotSettingsFile = userSettingsFilePath

      let settings = _options.settings

      if (!settings) {
        settings = _options.settings = new PluginSettings(userSettings)
      }

      if (reload) {
        settings.settings = userSettings
        return
      }

      const handler = async (a, b) => {
        debug('Settings changed', this.debugTag, a)

        if (!a.disabled && b.disabled) {
          // Enable plugin
          const [, freshSettings] = await loadFreshSettings()
          freshSettings.disabled = false
          a = Object.assign(a, freshSettings)
          settings.settings = a
          await this.load()
        }

        if (a.disabled && !b.disabled) {
          // Disable plugin
          const [, freshSettings] = await loadFreshSettings()
          freshSettings.disabled = true
          a = Object.assign(a, freshSettings)
          await this.unload()
        }

        if (a) {
          invokeHostExportedApi('save_plugin_user_settings', this.id, a)
        }
      }

      // observe settings
      settings.on('change', handler)

      return () => {}
    } catch (e) {
      debug('[load plugin user settings Error]', e)
      logger?.error(e)
    }
  }

  getMainUIContainer(): HTMLElement | undefined {
    if (this.shadow) {
      return this.caller?._getSandboxShadowContainer()
    }

    return this.caller?._getSandboxIframeContainer()
  }

  _resolveResourceFullUrl(filePath: string, localRoot?: string) {
    if (!filePath?.trim()) return
    localRoot = localRoot || this._localRoot
    const reg = /^(http|file)/
    if (!reg.test(filePath)) {
      const url = path.join(localRoot, filePath)
      filePath = reg.test(url) ? url : PROTOCOL_FILE + url
    }
    return !this.options.effect && this.isInstalledInDotRoot
      ? convertToLSPResource(filePath, this.dotPluginsRoot)
      : filePath
  }

  async _preparePackageConfigs() {
    const { url } = this._options
    let pkg: any

    try {
      if (!url) {
        throw new Error('Can not resolve package config location')
      }

      debug('prepare package root', url)

      pkg = await invokeHostExportedApi('load_plugin_config', url)

      if (!pkg || ((pkg = JSON.parse(pkg)), !pkg)) {
        throw new Error(`Parse package config error #${url}/package.json`)
      }
    } catch (e) {
      throw new IllegalPluginPackageError(e.message)
    }

    const localRoot = (this._localRoot = safetyPathNormalize(url))
    const logseq: Partial<LSPluginPkgConfig> = pkg.logseq || {}

      // Pick legal attrs
    ;[
      'name',
      'author',
      'repository',
      'version',
      'description',
      'repo',
      'title',
      'effect',
      'sponsors',
    ]
      .concat(!this.isInstalledInDotRoot ? ['devEntry'] : [])
      .forEach((k) => {
        this._options[k] = pkg[k]
      })

    const validateEntry = (main) => main && /\.(js|html)$/.test(main)

    // Entry from main
    const entry = logseq.entry || logseq.main || pkg.main
    if (validateEntry(entry)) {
      // Theme has no main
      this._options.entry = this._resolveResourceFullUrl(entry, localRoot)
      this._options.devEntry = logseq.devEntry

      if (logseq.mode) {
        this._options.mode = logseq.mode
      }
    }

    const title = logseq.title || pkg.title
    const icon = logseq.icon || pkg.icon

    this._options.title = title
    this._options.icon = icon && this._resolveResourceFullUrl(icon)
    this._options.theme = Boolean(logseq.theme || !!logseq.themes)

    // TODO: strategy for Logseq plugins center
    if (this.isInstalledInDotRoot) {
      this._id = path.basename(localRoot)
    } else {
      if (logseq.id) {
        this._id = logseq.id
      } else {
        logseq.id = this.id
        try {
          await invokeHostExportedApi('save_plugin_config', url, {
            ...pkg,
            logseq,
          })
        } catch (e) {
          debug('[save plugin ID Error] ', e)
        }
      }
    }

    // Validate id
    const { registeredPlugins, isRegistering } = this._ctx
    if (isRegistering && registeredPlugins.has(this.id)) {
      throw new ExistedImportedPluginPackageError(this.id)
    }

    return async () => {
      try {
        // 0. Install Themes
        const themes = logseq.themes

        if (themes) {
          await this._loadConfigThemes(
            Array.isArray(themes) ? themes : [themes]
          )
        }
      } catch (e) {
        debug('[prepare package effect Error]', e)
      }
    }
  }

  async _tryToNormalizeEntry() {
    let { entry, settings, devEntry } = this.options
    devEntry = devEntry || settings?.get('_devEntry')

    if (devEntry) {
      this._options.entry = devEntry
      return
    }

    if (!entry.endsWith('.js')) return

    let dirPathInstalled = null
    let tmp_file_method = 'write_user_tmp_file'
    if (this.isInstalledInDotRoot) {
      tmp_file_method = 'write_dotdir_file'
      dirPathInstalled = this._localRoot.replace(this.dotPluginsRoot, '')
      dirPathInstalled = path.join(DIR_PLUGINS, dirPathInstalled)
    }
    const tag = new Date().getDay()
    const sdkPathRoot = await getSDKPathRoot()
    const entryPath = await invokeHostExportedApi(
      tmp_file_method,
      `${this._id}_index.html`,
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>logseq plugin entry</title>
    ${
        IS_DEV
          ? `<script src="${sdkPathRoot}/lsplugin.user.js?v=${tag}"></script>`
          : `<script src="https://cdn.jsdelivr.net/npm/@logseq/libs/dist/lsplugin.user.min.js?v=${tag}"></script>`
      }
    
  </head>
  <body>
  <div id="app"></div>
  <script src="${entry}"></script>
  </body>
</html>`,
      dirPathInstalled
    )

    entry = convertToLSPResource(
      withFileProtocol(path.normalize(entryPath)),
      this.dotPluginsRoot
    )

    this._options.entry = entry
  }

  async _loadConfigThemes(themes: Theme[]) {
    themes.forEach((options) => {
      if (!options.url) return

      if (!options.url.startsWith('http') && this._localRoot) {
        options.url = path.join(this._localRoot, options.url)
        // file:// for native
        if (!options.url.startsWith('file:')) {
          options.url = 'assets://' + options.url
        }
      }

      this.emit('provider:theme', options)
    })
  }

  async _loadLayoutsData(): Promise<Record<string, any>> {
    const key = this.id + '_layouts'
    const [, layouts] = await invokeHostExportedApi(
      'load_plugin_user_settings',
      key
    )
    return layouts || {}
  }

  async _saveLayoutsData(data) {
    const key = this.id + '_layouts'
    await invokeHostExportedApi('save_plugin_user_settings', key, data)
  }

  async _persistMainUILayoutData(e: {
    width: number
    height: number
    left: number
    top: number
  }) {
    const layouts = await this._loadLayoutsData()
    layouts.$$0 = e
    await this._saveLayoutsData(layouts)
  }

  _setupDraggableContainer(
    el: HTMLElement,
    opts: Partial<{ key: string; title: string; close: () => void }> = {}
  ): () => void {
    const ds = el.dataset
    if (ds.inited_draggable) return
    if (!ds.identity) {
      ds.identity = 'dd-' + genID()
    }
    const isInjectedUI = !!opts.key
    const handle = document.createElement('div')
    handle.classList.add('draggable-handle')

    handle.innerHTML = `
      <div class="th">
        <div class="l"><h3>${opts.title || ''}</h3></div>
        <div class="r">
          <a class="button x"><i class="ti ti-x"></i></a>
        </div>
      </div>
    `

    handle.querySelector('.x').addEventListener(
      'click',
      (e) => {
        opts?.close?.()
        e.stopPropagation()
      },
      false
    )

    handle.addEventListener(
      'mousedown',
      (e) => {
        const target = e.target as HTMLElement
        if (target?.closest('.r')) {
          e.stopPropagation()
          e.preventDefault()
        }
      },
      false
    )

    el.prepend(handle)

    // move to top
    el.addEventListener(
      'mousedown',
      (e) => {
        this.layoutCore.move_container_to_top(ds.identity)
      },
      true
    )

    const setTitle = (title) => {
      handle.querySelector('h3').textContent = title
    }
    const dispose = this.layoutCore.setup_draggable_container_BANG_(
      el,
      !isInjectedUI ? this._persistMainUILayoutData.bind(this) : () => {}
    )

    ds.inited_draggable = 'true'

    if (opts.title) {
      setTitle(opts.title)
    }

    // click outside
    let removeOutsideListener = null
    if (ds.close === 'outside') {
      const handler = (e) => {
        const target = e.target
        if (!el.contains(target)) {
          opts.close()
        }
      }

      document.addEventListener('click', handler, false)
      removeOutsideListener = () => {
        document.removeEventListener('click', handler)
      }
    }

    return () => {
      dispose()
      removeOutsideListener?.()
    }
  }

  _setupResizableContainer(el: HTMLElement, key?: string): () => void {
    const ds = el.dataset
    if (ds.inited_resizable) return
    if (!ds.identity) {
      ds.identity = 'dd-' + genID()
    }
    const handle = document.createElement('div')
    handle.classList.add('resizable-handle')
    el.prepend(handle)

    // @ts-expect-error
    const layoutCore = window.frontend.modules.layout.core
    const dispose = layoutCore.setup_resizable_container_BANG_(
      el,
      !key ? this._persistMainUILayoutData.bind(this) : () => {}
    )

    ds.inited_resizable = 'true'
    return dispose
  }

  async load(
    opts?: Partial<{
      indicator: DeferredActor
      reload: boolean
    }>
  ) {
    if (this.pending) {
      return
    }

    this._status = PluginLocalLoadStatus.LOADING
    this._loadErr = undefined

    try {
      // if (!this.options.entry) { // Themes package no entry field
      // }

      const installPackageThemes = await this._preparePackageConfigs()

      this._dispose(await this._setupUserSettings(opts?.reload))

      if (!this.disabled) {
        await installPackageThemes.call(null)
      }

      if (this.disabled || !this.options.entry) {
        return
      }

      await this._tryToNormalizeEntry()

      this._caller = new LSPluginCaller(this)
      await this._caller.connectToChild()

      const readyFn = () => {
        this._caller?.callUserModel(LSPMSG_READY, { pid: this.id })
      }

      if (opts?.indicator) {
        opts.indicator.promise.then(readyFn)
      } else {
        readyFn()
      }

      this._dispose(async () => {
        await this._caller?.destroy()
      })

      this._dispose(cleanInjectedScripts.bind(this))
    } catch (e) {
      this.logger.error('load', e, true)

      this.dispose().catch(null)
      this._status = PluginLocalLoadStatus.ERROR
      this._loadErr = e
    } finally {
      if (!this._loadErr) {
        if (this.disabled) {
          this._status = PluginLocalLoadStatus.UNLOADED
        } else {
          this._status = PluginLocalLoadStatus.LOADED
        }
      }
    }
  }

  async reload() {
    if (this.pending) {
      return
    }

    this._ctx.emit('beforereload', this)
    await this.unload()
    await this.load({ reload: true })
    this._ctx.emit('reloaded', this)
  }

  /**
   * @param unregister If true delete plugin files
   */
  async unload(unregister: boolean = false) {
    if (this.pending) {
      return
    }

    if (unregister) {
      await this.unload()

      if (this.isInstalledInDotRoot) {
        this._ctx.emit('unlink-plugin', this.id)
      }

      return
    }

    try {
      const eventBeforeUnload = { unregister }

      if (this.loaded) {
        this._status = PluginLocalLoadStatus.UNLOADING

        try {
          await this._caller?.callUserModel(
            AWAIT_LSPMSGFn(LSPMSG_BEFORE_UNLOAD),
            eventBeforeUnload
          )
          this.emit('beforeunload', eventBeforeUnload)
        } catch (e) {
          this.logger.error('beforeunload', e)
        }

        await this.dispose()
      }

      this.emit('unloaded')
    } catch (e) {
      this.logger.error('unload', e)
    } finally {
      this._status = PluginLocalLoadStatus.UNLOADED
    }
  }

  private async dispose() {
    for (const fn of this._disposes) {
      try {
        fn && (await fn())
      } catch (e) {
        console.error(this.debugTag, 'dispose Error', e)
      }
    }

    // clear
    this._disposes = []
  }

  _dispose(fn: any) {
    if (!fn) return
    this._disposes.push(fn)
  }

  _onHostMounted(callback: () => void) {
    const actor = this._ctx.hostMountedActor

    if (!actor || actor.settled) {
      callback()
    } else {
      actor?.promise.then(callback)
    }
  }

  get layoutCore(): any {
    // @ts-expect-error
    return window.frontend.modules.layout.core
  }

  get isInstalledInDotRoot() {
    const dotRoot = this.dotConfigRoot
    const plgRoot = this.localRoot
    return dotRoot && plgRoot && plgRoot.startsWith(dotRoot)
  }

  get loaded() {
    return this._status === PluginLocalLoadStatus.LOADED
  }

  get pending() {
    return [
      PluginLocalLoadStatus.LOADING,
      PluginLocalLoadStatus.UNLOADING,
    ].includes(this._status)
  }

  get status(): PluginLocalLoadStatus {
    return this._status
  }

  get settings() {
    return this.options.settings
  }

  set settingsSchema(schema: SettingSchemaDesc[]) {
    this._options.settingsSchema = schema
  }

  get settingsSchema() {
    return this.options.settingsSchema
  }

  get logger() {
    return this._logger
  }

  get disabled() {
    return this.settings?.get('disabled')
  }

  get theme() {
    return this.options.theme
  }

  get caller() {
    return this._caller
  }

  get id(): string {
    return this._id
  }

  get shadow(): boolean {
    return this.options.mode === 'shadow'
  }

  get options(): PluginLocalOptions {
    return this._options
  }

  get themeMgr(): ILSPluginThemeManager {
    return this._themeMgr
  }

  get debugTag() {
    const name = this._options?.name
    return `#${this._id} - ${name ?? ''}`
  }

  get localRoot(): string {
    return this._localRoot || this._options.url
  }

  get loadErr(): Error | undefined {
    return this._loadErr
  }

  get dotConfigRoot() {
    return path.normalize(this._ctx.options.dotConfigRoot)
  }

  get dotSettingsFile(): string | undefined {
    return this._dotSettingsFile
  }

  get dotPluginsRoot() {
    return path.join(this.dotConfigRoot, DIR_PLUGINS)
  }

  get sdk(): Partial<PluginLocalSDKMetadata> {
    return this._sdk
  }

  set sdk(value: Partial<PluginLocalSDKMetadata>) {
    this._sdk = value
  }

  toJSON() {
    const json = { ...this.options } as any
    json.id = this.id
    json.err = this.loadErr
    json.usf = this.dotSettingsFile
    json.iir = this.isInstalledInDotRoot
    json.lsr = this._resolveResourceFullUrl('/')
    json.settings = json.settings?.toJSON()

    return json
  }
}

/**
 * Host plugin core
 */
class LSPluginCore
  extends EventEmitter<
    | 'beforeenable'
    | 'enabled'
    | 'beforedisable'
    | 'disabled'
    | 'registered'
    | 'error'
    | 'unregistered'
    | 'ready'
    | 'themes-changed'
    | 'theme-selected'
    | 'reset-custom-theme'
    | 'settings-changed'
    | 'unlink-plugin'
    | 'beforereload'
    | 'reloaded'
  >
  implements ILSPluginThemeManager {
  private _isRegistering = false
  private _readyIndicator?: DeferredActor
  private readonly _hostMountedActor: DeferredActor = deferred()
  private readonly _userPreferences: UserPreferences = {
    theme: null,
    themes: {
      mode: 'light',
      light: null,
      dark: null,
    },
    externals: [],
  }
  private readonly _registeredThemes = new Map<PluginLocalIdentity, Theme[]>()
  private readonly _registeredPlugins = new Map<
    PluginLocalIdentity,
    PluginLocal
  >()
  private _currentTheme: {
    pid: PluginLocalIdentity
    opt: Theme | LegacyTheme
    eject: () => void
  }

  /**
   * @param _options
   */
  constructor(private readonly _options: Partial<LSPluginCoreOptions>) {
    super()
  }

  async loadUserPreferences() {
    try {
      const settings = await invokeHostExportedApi('load_user_preferences')

      if (settings) {
        Object.assign(this._userPreferences, settings)
      }
    } catch (e) {
      debug('[load user preferences Error]', e)
    }
  }

  async saveUserPreferences(settings: Partial<UserPreferences>) {
    try {
      if (settings) {
        Object.assign(this._userPreferences, settings)
      }

      await invokeHostExportedApi(
        'save_user_preferences',
        this._userPreferences
      )
    } catch (e) {
      debug('[save user preferences Error]', e)
    }
  }

  /**
   * Activate the user preferences.
   *
   * Steps:
   *
   * 1. Load the custom theme.
   *
   * @memberof LSPluginCore
   */
  async activateUserPreferences() {
    const { theme: legacyTheme, themes } = this._userPreferences
    const currentTheme = themes[themes.mode]

    // If there is currently a theme that has been set
    if (currentTheme) {
      await this.selectTheme(currentTheme, { effect: false })
    } else if (legacyTheme) {
      // Otherwise compatible with older versions
      await this.selectTheme(legacyTheme, { effect: false })
    }
  }

  /**
   * @param plugins
   * @param initial
   */
  async register(
    plugins: RegisterPluginOpts[] | RegisterPluginOpts,
    initial = false
  ) {
    if (!Array.isArray(plugins)) {
      await this.register([plugins])
      return
    }

    const perfTable = new Map<
      string,
      { o: PluginLocal; s: number; e: number }
    >()
    const debugPerfInfo = () => {
      const data: any = Array.from(perfTable.values()).reduce((ac, it) => {
        const { id, options, status, disabled } = it.o

        if (
          disabled !== true &&
          (options.entry || (!options.name && !options.entry))
        ) {
          ac[id] = {
            name: options.name,
            entry: options.entry,
            status: status,
            enabled:
              typeof disabled === 'boolean' ? (!disabled ? '🟢' : '⚫️') : '🔴',
            perf: !it.e ? it.o.loadErr : `${(it.e - it.s).toFixed(2)}ms`,
          }
        }

        return ac
      }, {})

      console.table(data)
    }

    // @ts-expect-error
    window.__debugPluginsPerfInfo = debugPerfInfo

    try {
      this._isRegistering = true

      const userConfigRoot = this._options.dotConfigRoot
      const readyIndicator = (this._readyIndicator = deferred())

      await this.loadUserPreferences()

      let externals = new Set(this._userPreferences.externals)

      // valid externals
      if (externals?.size) {
        try {
          const validatedExternals: Record<string, boolean> =
            await invokeHostExportedApi('validate_external_plugins', [
              ...externals,
            ])

          externals = new Set(
            [...Object.entries(validatedExternals)].reduce((a, [k, v]) => {
              if (v) {
                a.push(k)
              }
              return a
            }, [])
          )
        } catch (e) {
          console.error('[validatedExternals Error]', e)
        }
      }

      if (initial) {
        plugins = plugins.concat(
          [...externals]
            .filter((url) => {
              return (
                !plugins.length ||
                (plugins as RegisterPluginOpts[]).every(
                  (p) => !p.entry && p.url !== url
                )
              )
            })
            .map((url) => ({ url }))
        )
      }

      for (const pluginOptions of plugins) {
        const { url } = pluginOptions as PluginLocalOptions
        const pluginLocal = new PluginLocal(
          pluginOptions as PluginLocalOptions,
          this,
          this
        )

        const perfInfo = { o: pluginLocal, s: performance.now(), e: 0 }
        perfTable.set(url, perfInfo)

        await pluginLocal.load({ indicator: readyIndicator })

        perfInfo.e = performance.now()

        const { loadErr } = pluginLocal

        if (loadErr) {
          debug('[Failed LOAD Plugin] #', pluginOptions)

          this.emit('error', loadErr)

          if (
            loadErr instanceof IllegalPluginPackageError ||
            loadErr instanceof ExistedImportedPluginPackageError
          ) {
            // TODO: notify global log system?
            continue
          }
        }

        pluginLocal.settings?.on('change', (a) => {
          this.emit('settings-changed', pluginLocal.id, a)
          pluginLocal.caller?.callUserModel(LSPMSG_SETTINGS, { payload: a })
        })

        this._registeredPlugins.set(pluginLocal.id, pluginLocal)
        this.emit('registered', pluginLocal)

        // external plugins
        if (!pluginLocal.isInstalledInDotRoot) {
          externals.add(url)
        }
      }

      await this.saveUserPreferences({ externals: Array.from(externals) })
      await this.activateUserPreferences()

      readyIndicator.resolve('ready')
    } catch (e) {
      console.error(e)
    } finally {
      this._isRegistering = false
      this.emit('ready', perfTable)
      debugPerfInfo()
    }
  }

  async reload(plugins: PluginLocalIdentity[] | PluginLocalIdentity) {
    if (!Array.isArray(plugins)) {
      await this.reload([plugins])
      return
    }

    for (const identity of plugins) {
      try {
        const p = this.ensurePlugin(identity)
        await p.reload()
      } catch (e) {
        debug(e)
      }
    }
  }

  async unregister(plugins: PluginLocalIdentity[] | PluginLocalIdentity) {
    if (!Array.isArray(plugins)) {
      await this.unregister([plugins])
      return
    }

    const unregisteredExternals: string[] = []

    for (const identity of plugins) {
      const p = this.ensurePlugin(identity)

      if (!p.isInstalledInDotRoot) {
        unregisteredExternals.push(p.options.url)
      }

      await p.unload(true)

      this._registeredPlugins.delete(identity)
      this.emit('unregistered', identity)
    }

    const externals = this._userPreferences.externals
    if (externals.length && unregisteredExternals.length) {
      await this.saveUserPreferences({
        externals: externals.filter((it) => {
          return !unregisteredExternals.includes(it)
        }),
      })
    }
  }

  async enable(plugin: PluginLocalIdentity) {
    const p = this.ensurePlugin(plugin)
    if (p.pending) return

    this.emit('beforeenable')
    p.settings?.set('disabled', false)
    this.emit('enabled', p.id)
  }

  async disable(plugin: PluginLocalIdentity) {
    const p = this.ensurePlugin(plugin)
    if (p.pending) return

    this.emit('beforedisable')
    p.settings?.set('disabled', true)
    this.emit('disabled', p.id)
  }

  async _hook(ns: string, type: string, payload?: any, pid?: string) {
    const hook = `${ns}:${safeSnakeCase(type)}`
    const isDbChangedHook = hook === 'hook:db:changed'
    const isDbBlockChangeHook = hook.startsWith('hook:db:block')

    const act = (p: PluginLocal) => {
      debug(`[call hook][#${p.id}]`, ns, type)
      p.caller?.callUserModel(LSPMSG, {
        ns,
        type: safeSnakeCase(type),
        payload,
      })
    }

    const p = pid && this._registeredPlugins.get(pid)

    if (p && !p.disabled && p.options.entry) {
      act(p)
      return
    }

    for (const [_, p] of this._registeredPlugins) {
      if (!p.options.entry || p.disabled) {
        continue
      }

      if (!pid) {
        // compatible for old SDK < 0.0.2
        const sdkVersion = p.sdk?.version

        // TODO: remove optimization after few releases
        if (!sdkVersion) {
          if (isDbChangedHook || isDbBlockChangeHook) {
            continue
          } else {
            act(p)
          }
        }

        if (
          sdkVersion &&
          invokeHostExportedApi('should_exec_plugin_hook', p.id, hook)
        ) {
          act(p)
        }
      } else if (pid === p.id) {
        act(p)
        break
      }
    }
  }

  async hookApp(type: string, payload?: any, pid?: string) {
    return await this._hook('hook:app', type, payload, pid)
  }

  async hookEditor(type: string, payload?: any, pid?: string) {
    return await this._hook('hook:editor', type, payload, pid)
  }

  async hookDb(type: string, payload?: any, pid?: string) {
    return await this._hook('hook:db', type, payload, pid)
  }

  ensurePlugin(plugin: PluginLocalIdentity | PluginLocal) {
    if (plugin instanceof PluginLocal) {
      return plugin
    }

    const p = this._registeredPlugins.get(plugin)

    if (!p) {
      throw new Error(`plugin #${plugin} not existed.`)
    }

    return p
  }

  hostMounted() {
    this._hostMountedActor.resolve()
  }

  _forceCleanInjectedUI(id: string) {
    if (!id) return
    return cleanInjectedUI(id)
  }

  get registeredPlugins(): Map<PluginLocalIdentity, PluginLocal> {
    return this._registeredPlugins
  }

  get options() {
    return this._options
  }

  get readyIndicator(): DeferredActor | undefined {
    return this._readyIndicator
  }

  get hostMountedActor(): DeferredActor {
    return this._hostMountedActor
  }

  get isRegistering(): boolean {
    return this._isRegistering
  }

  get themes() {
    return this._registeredThemes
  }

  get enabledPlugins() {
    return [...this.registeredPlugins.entries()].reduce((a, b) => {
      let p = b?.[1]
      if (p?.disabled !== true) {
        a.set(b?.[0], p)
      }
      return a
    }, new Map())
  }

  async registerTheme(id: PluginLocalIdentity, opt: Theme): Promise<void> {
    debug('Register theme #', id, opt)

    if (!id) return
    let themes: Theme[] = this._registeredThemes.get(id)!
    if (!themes) {
      this._registeredThemes.set(id, (themes = []))
    }

    themes.push(opt)
    this.emit('themes-changed', this.themes, { id, ...opt })
  }

  async selectTheme(
    theme: Theme | LegacyTheme,
    options: {
      effect?: boolean
      emit?: boolean
    } = {}
  ) {
    const { effect, emit } = Object.assign(
      {},
      { effect: true, emit: true },
      options
    )

    // Clear current theme before injecting.
    if (this._currentTheme) {
      this._currentTheme.eject()
    }

    // Detect if it is the default theme (no url).
    if (!theme.url) {
      this._currentTheme = null
    } else {
      const ejectTheme = injectTheme(theme.url)

      this._currentTheme = {
        pid: theme.pid,
        opt: theme,
        eject: ejectTheme,
      }
    }

    if (effect) {
      await this.saveUserPreferences(
        theme.mode
          ? {
            themes: {
              ...this._userPreferences.themes,
              mode: theme.mode,
              [theme.mode]: theme,
            },
          }
          : { theme: theme }
      )
    }

    if (emit) {
      this.emit('theme-selected', theme)
    }
  }

  async unregisterTheme(id: PluginLocalIdentity, effect = true) {
    debug('Unregister theme #', id)

    if (!this._registeredThemes.has(id)) {
      return
    }

    this._registeredThemes.delete(id)
    this.emit('themes-changed', this.themes, { id })
    if (effect && this._currentTheme?.pid === id) {
      this._currentTheme.eject()
      this._currentTheme = null

      const { theme, themes } = this._userPreferences
      await this.saveUserPreferences({
        theme: theme?.pid === id ? null : theme,
        themes: {
          ...themes,
          light: themes.light?.pid === id ? null : themes.light,
          dark: themes.dark?.pid === id ? null : themes.dark,
        },
      })

      // Reset current theme if it is unregistered
      this.emit('reset-custom-theme', this._userPreferences.themes)
    }
  }
}

function setupPluginCore(options: any) {
  const pluginCore = new LSPluginCore(options)

  debug('=== 🔗 Setup Logseq Plugin System 🔗 ===')

  window.LSPluginCore = pluginCore
  window.DOMPurify = DOMPurify
}

export { PluginLocal, pluginHelpers, setupPluginCore }