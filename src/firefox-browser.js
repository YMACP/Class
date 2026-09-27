// Firefox's native WebDriver BiDi endpoint needs no driver or automation package.
// This adapter only translates the commands used by BrowserTools; ownership,
// pause/stop, DOM operations, output limits and effect tracking stay shared.
const specialKeys = {
  Enter: '\uE007', Tab: '\uE004', Escape: '\uE00C', Backspace: '\uE003', Delete: '\uE017',
  ArrowLeft: '\uE012', ArrowUp: '\uE013', ArrowRight: '\uE014', ArrowDown: '\uE015',
  Home: '\uE011', End: '\uE010', PageUp: '\uE00E', PageDown: '\uE00F',
};
const modifierKeys = [[1, '\uE00A'], [2, '\uE009'], [4, '\uE03D'], [8, '\uE008']];

export class FirefoxConnection {
  constructor(connection, checkpoint = async () => {}) {
    this.connection = connection;
    this.checkpoint = checkpoint;
  }
  get closed() { return this.connection.closed; }
  close() { return this.connection.close(); }

  async _send(method, params, signal, onSent) {
    signal?.throwIfAborted();
    await this.checkpoint(signal);
    signal?.throwIfAborted();
    return this.connection.send(method, params, undefined, signal, onSent);
  }

  async initialize(signal) {
    const { capabilities } = await this._send('session.new', { capabilities: {} }, signal);
    const major = Number.parseInt(capabilities?.browserVersion, 10);
    if (capabilities?.browserName?.toLowerCase() !== 'firefox') throw new Error('The selected browser is not Firefox');
    if (!Number.isFinite(major) || major < 149) {
      throw new Error('Firefox 149 or newer is required for browser automation; please update Firefox or select Chrome/Edge');
    }
  }

  async _evaluate(expression, context, signal, onSent, userActivation = false) {
    // BrowserTools returns JSON-compatible values. Serialize in the page instead
    // of maintaining a general BiDi remote-object/DOM-node deserializer.
    const result = await this._send('script.evaluate', {
      expression: `JSON.stringify((${expression}))`, target: { context },
      awaitPromise: false, resultOwnership: 'none', userActivation,
    }, signal, onSent);
    if (result.type === 'exception') {
      const text = result.exceptionDetails?.text || 'Firefox page evaluation failed';
      return { exceptionDetails: { text, exception: { description: text } } };
    }
    if (result.type !== 'success') throw new Error('Firefox returned an invalid script result');
    if (result.result?.type === 'undefined') return { result: { value: undefined } };
    if (result.result?.type !== 'string') throw new Error('Firefox returned an invalid serialized script value');
    return { result: { value: JSON.parse(result.result.value) } };
  }

  async send(method, params = {}, context, signal, onSent) {
    // Local-only translations must respect pause and cancellation as well.
    if (method === 'Target.attachToTarget' || method === 'Page.enable') {
      signal?.throwIfAborted();
      await this.checkpoint(signal);
      signal?.throwIfAborted();
      return method === 'Target.attachToTarget' ? { sessionId: params.targetId } : {};
    }
    if (method === 'Target.getTargets') {
      const { contexts } = await this._send('browsingContext.getTree', { maxDepth: 0 }, signal, onSent);
      const targetInfos = [];
      for (const tab of contexts) {
        const title = await this._evaluate('document.title', tab.context, signal);
        if (title.exceptionDetails) throw new Error(title.exceptionDetails.text);
        targetInfos.push({ type: 'page', targetId: tab.context, title: title.result.value, url: tab.url });
      }
      return { targetInfos };
    }
    if (method === 'Target.createTarget') {
      if (params.url !== 'about:blank') throw new Error('Firefox tab creation requires about:blank');
      const result = await this._send('browsingContext.create', { type: 'tab' }, signal, onSent);
      return { targetId: result.context };
    }
    if (method === 'Target.closeTarget') {
      await this._send('browsingContext.close', { context: params.targetId, promptUnload: false }, signal, onSent);
      return { success: true };
    }
    if (method === 'Emulation.setDeviceMetricsOverride') {
      return this._send('browsingContext.setViewport', {
        context, viewport: { width: params.width, height: params.height }, devicePixelRatio: params.deviceScaleFactor,
      }, signal, onSent);
    }
    if (method === 'Page.navigate') {
      await this._send('browsingContext.navigate', { context, url: params.url, wait: 'interactive' }, signal, onSent);
      return {};
    }
    if (method === 'Runtime.evaluate') return this._evaluate(params.expression, context, signal, onSent, params.userGesture === true);
    if (method === 'Page.captureScreenshot') {
      return this._send('browsingContext.captureScreenshot', { context, origin: 'viewport', format: { type: 'image/png' } }, signal, onSent);
    }
    if (method === 'Browser.setDownloadBehavior') {
      if (params.behavior !== 'deny') throw new Error('Firefox browser downloads must remain disabled');
      try {
        return await this._send('browser.setDownloadBehavior', { downloadBehavior: { type: 'denied' } }, signal, onSent);
      } catch (error) {
        if (signal?.aborted) throw error;
        throw Object.assign(new Error(`Firefox could not disable downloads; please use Firefox 149 or newer: ${error.message}`, { cause: error }), {
          browserRequestState: error.browserRequestState,
        });
      }
    }
    if (method === 'Input.dispatchMouseEvent') {
      let source;
      if (params.type === 'mousePressed') {
        source = { type: 'pointer', id: 'class-pointer', parameters: { pointerType: 'mouse' }, actions: [
          { type: 'pointerMove', x: params.x, y: params.y, origin: 'viewport', duration: 0 },
          { type: 'pointerDown', button: 0 },
        ] };
      } else if (params.type === 'mouseReleased') {
        source = { type: 'pointer', id: 'class-pointer', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerUp', button: 0 }] };
      } else if (params.type === 'mouseWheel') {
        source = { type: 'wheel', id: 'class-wheel', actions: [{
          type: 'scroll', x: Math.round(params.x), y: Math.round(params.y),
          deltaX: Math.round(params.deltaX), deltaY: Math.round(params.deltaY), origin: 'viewport', duration: 0,
        }] };
      } else throw new Error(`Unsupported Firefox mouse event: ${params.type}`);
      return this._send('input.performActions', { context, actions: [source] }, signal, onSent);
    }
    if (method === 'Input.dispatchKeyEvent') {
      const key = specialKeys[params.key] ?? params.key;
      const modifiers = modifierKeys.filter(([bit]) => (params.modifiers & bit) !== 0).map(([, value]) => value);
      let actions;
      if (params.type === 'keyDown') {
        actions = [...modifiers, key].map(value => ({ type: 'keyDown', value }));
      } else if (params.type === 'keyUp') {
        actions = [key, ...modifiers.reverse()].map(value => ({ type: 'keyUp', value }));
      } else throw new Error(`Unsupported Firefox key event: ${params.type}`);
      return this._send('input.performActions', { context, actions: [{ type: 'key', id: 'class-keyboard', actions }] }, signal, onSent);
    }
    throw new Error(`Unsupported Firefox browser command: ${method}`);
  }
}
