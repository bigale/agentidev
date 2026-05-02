// ***********************************************
// SmartClient Playwright Commands
// Custom helpers for integrating Playwright with
// Isomorphic SmartClient using AutoTest locators.
// ***********************************************

const { expect } = require('@playwright/test');

/**
 * _waitForElementHandle(): wait for a locator and return a JSHandle.
 * Uses isc.AutoTest.waitForElement on the page.
 */
async function _waitForElementHandle(page, locator, options = {}) {
  return await page.evaluateHandle(
    async ({ locator, options }) => {
      const isc = globalThis.isc;
      if (!isc?.AutoTest) throw new Error('isc.AutoTest not available');
      
      return new Promise((resolve, reject) => {
        try {
          isc.AutoTest.waitForElement(
            locator,
            (el, done) => {
              if (done === false) {
                reject(new Error(`AutoTest.waitForElement() timed out for locator: ${locator}`));
              } else {
                resolve(el || null);
              }
            },
            options || {}
          );
        } catch (e) {
          reject(e);
        }
      });
    },
    { locator, options }
  );
}

/** _assertLooksAutoTest(): basic check that locator looks like an AutoTest locator. */
function _assertLooksAutoTest(locator) {
  if (typeof locator !== 'string' || !locator.startsWith('//')) {
    throw new Error(`Expected AutoTest locator starting with "//". Got: ${locator}`);
  }
}

class SmartClientCommands {
  /** Attach to a Playwright Page. */
  constructor(page) {
    this.page = page;
    this.config = {
      scCommandTimeout: 30000,
      scLogCommands: false,
      scAutoWait: true,
      scLogLevel: 'debug'
    };
  }

  /** Log messages with configurable levels. */
  log(cmd, details = '', level = 'info') {
    if (this.config.scLogLevel === 'silent') return;
    
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    const currentLevel = levels[this.config.scLogLevel] || 1;
    const messageLevel = levels[level] || 1;
    if (messageLevel >= currentLevel) {
      const prefix = level === 'error' ? '[SC ERROR]' : level === 'warn' ? '[SC WARN]' : '[SC]';
      console.log(`${prefix} ${cmd} ${details}`);
    }
  }

  // getSCTimeout(): resolve timeout from options or SmartClient configuration
  async getSCTimeout(options = {}) {
    try {
      this.log('getSCTimeout', 'Resolving timeout', 'debug');
      const timeout = await this.page.evaluate((o) => {
        if (!globalThis.isc?.AutoTest) return 30000;
        if (o && o.timeout != null) return o.timeout;
        return globalThis.isc.AutoTest.waitForTimeOutSeconds * 1000;
      }, options);
      this.log('getSCTimeout', `Resolved timeout: ${timeout}ms`, 'info');
      if (timeout > 60000) {
        this.log('getSCTimeout', `Very long timeout configured: ${timeout}ms`, 'warn');
      }
      return timeout;
    } catch (error) {
      this.log('getSCTimeout', `Failed: ${error.message}`, 'error');
      throw error;
    }
  }

  // getSC(): resolve a locator to an ElementHandle using AutoTest
  async getSC(locator, options = {}) {
    try {
      _assertLooksAutoTest(locator);
      this.log('getSC', `Resolving element: ${locator}`, 'info');
      const timeout = await this.getSCTimeout(options);
      this.log('getSC', `Waiting for element with timeout: ${timeout}ms`, 'debug');

      const startTime = Date.now();
      const handle = await Promise.race([
        _waitForElementHandle(this.page, locator, options),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`Timed out waiting for locator: ${locator}`)), timeout))
      ]);
      const waitTime = Date.now() - startTime;
      if (waitTime > timeout * 0.8) {
        this.log('getSC', `Element found after long wait: ${waitTime}ms (${Math.round(waitTime/timeout*100)}% of timeout)`, 'warn');
      }

      const el = await handle?.asElement();
      if (!el) throw new Error(`AutoTest locator not resolved: ${locator}`);
      
      if (this.config.scAutoWait && !options.skipAutoWait) {
        await this.waitForSCDone(options);
      }
      
      this.log('getSC', `Successfully resolved element: ${locator}`, 'debug');
      return el;
    } catch (error) {
      this.log('getSC', `Failed: ${error.message}`, 'error');
      throw error;
    }
  }

  // waitForSCDone(): wait for SmartClient operations to complete
  async waitForSCDone(options = {}) {
    let timeoutMs;  // hoisted so the catch block can reference it (vendored fix)
    try {
      this.log('waitForSCDone', 'Starting SmartClient operations wait', 'info');
      timeoutMs = await this.getSCTimeout(options);
      this.log('waitForSCDone', `Waiting for SmartClient operations to complete (timeout: ${timeoutMs}ms)`, 'debug');

      await Promise.race([
        this.page.evaluate(
          ({ options }) =>
            new Promise((resolve) => {
              const isc = globalThis.isc;
              if (!isc?.AutoTest) return resolve();
              isc.AutoTest.waitForSystemDone(() => resolve(), options || {});
            }),
          { options }
        ),
        new Promise((_, rej) => setTimeout(() => rej(new Error('waitForSCDone timeout')), timeoutMs))
      ]);
      this.log('waitForSCDone', 'SmartClient operations completed', 'debug');
    } catch (error) {
      if (error.message.includes('timeout')) {
        this.log('waitForSCDone', `SmartClient operations timed out after ${timeoutMs}ms`, 'warn');
      }
      this.log('waitForSCDone', `Failed: ${error.message}`, 'error');
      throw error;
    }
  }

  // clickSC(): click center of element resolved by locator
  async clickSC(locator, options = {}) {
    _assertLooksAutoTest(locator);
    this.log('clickSC', `Preparing to click: ${locator}`, 'info');
    
    try {
      const getSCOptions = options.skipAutoWait ? { ...options, skipAutoWait: true } : { ...options, skipAutoWait: false };
      const el = await this.getSC(locator, getSCOptions);
      const box = await el.boundingBox();
      if (!box) {
        this.log('clickSC', `Element not visible for click: ${locator}`, 'warn');
        throw new Error(`Element not visible for click: ${locator}`);
      }

      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      this.log('clickSC', `Clicking at coordinates: (${Math.round(x)}, ${Math.round(y)})`, 'info');

      await this.page.mouse.move(x, y);
      await this.page.mouse.down();
      await this.page.mouse.up();

      if (this.config.scAutoWait && !options.skipAutoWait) {
        await this.waitForSCDone(options);
      }
      
      this.log('clickSC', `Successfully clicked: ${locator}`, 'debug');
    } catch (error) {
      this.log('clickSC', `Failed: ${error.message}`, 'error');
      throw error;
    }
  }

  // typeSC(): focus element by locator, select-all, type text
  async typeSC(locator, text, options = {}) {
    try {
      _assertLooksAutoTest(locator);
      this.log('typeSC', `Preparing to type: ${locator} = "${text}"`, 'info');
      
      const clickOptions = options.skipAutoWait ? { ...options, skipAutoWait: true } : { ...options, skipAutoWait: false };
      await this.clickSC(locator, clickOptions);
      this.log('typeSC', `Clearing existing text and typing: "${text}"`, 'info');
      await this.page.keyboard.press('Control+A').catch(() => {});
      if (text.length > 100) {
        this.log('typeSC', `Typing long text (${text.length} characters)`, 'warn');
      }
      await this.page.keyboard.type(text);

      if (this.config.scAutoWait && !options.skipAutoWait) {
        await this.waitForSCDone(options);
      }
      
      this.log('typeSC', `Successfully typed: "${text}" into ${locator}`, 'debug');
    } catch (error) {
      this.log('typeSC', `Failed: ${error.message}`, 'error');
      throw error;
    }
  }

  // hoverSC(): hover element by locator
  async hoverSC(locator, options = {}) {
    try {
      _assertLooksAutoTest(locator);
      this.log('hoverSC', `Preparing to hover: ${locator}`, 'info');
      
      const getSCOptions = { ...options, skipAutoWait: options.skipAutoWait };
      const el = await this.getSC(locator, getSCOptions);
      this.log('hoverSC', `Hovering over element: ${locator}`, 'info');
      await el.hover();
      
      if (this.config.scAutoWait && !options.skipAutoWait) {
        await this.waitForSCDone(options);
      }
      
      this.log('hoverSC', `Successfully hovered: ${locator}`, 'debug');
    } catch (error) {
      this.log('hoverSC', `Failed: ${error.message}`, 'error');
      throw error;
    }
  }

  // scrollSC(): scroll a SmartClient Canvas by locator
  async scrollSC(locator, left, top, options = {}) {
    try {
      _assertLooksAutoTest(locator);
      this.log('scrollSC', `Preparing to scroll: ${locator}, left=${left}, top=${top}`, 'info');
      const timeout = await this.getSCTimeout(options);
      if (!options) options = {};
      options.timeout = timeout;
      
      const scrollType = (typeof left === 'string' && left.endsWith('%')) || (typeof top === 'string' && top.endsWith('%')) ? 'percentage' : 'pixel';
      this.log('scrollSC', `Using ${scrollType} scrolling`, 'info');
      
      if (typeof left === 'number' && Math.abs(left) > 1000) {
        this.log('scrollSC', `Large horizontal scroll value: ${left}px`, 'warn');
      }
      if (typeof top === 'number' && Math.abs(top) > 1000) {
        this.log('scrollSC', `Large vertical scroll value: ${top}px`, 'warn');
      }

      await Promise.race([
        this.page.evaluate(
          ({ locator, left, top, options }) =>
            new Promise((resolve, reject) => {
              const isc = globalThis.isc;
              const at = isc?.AutoTest;
              if (!at) return reject(new Error('isc.AutoTest not available'));

              const isPct = (v) => typeof v === 'string' && v.endsWith('%');

              const cb = (el, done) => {
                if (done === false) return resolve();
                if (!el) return resolve();

                const canvas = at.locateCanvasFromDOMElement(el);
                if (!canvas) return resolve();

                if ((left == null || isPct(left)) && (top == null || isPct(top)) && typeof canvas.scrollToPercent === 'function') {
                  canvas.scrollToPercent(isPct(left) ? left : null, isPct(top) ? top : null);
                } else if (typeof canvas.scrollTo === 'function') {
                  canvas.scrollTo(left ?? null, top ?? null);
                }
                resolve();
              };

              try {
                at.waitForElement(locator, cb, options || {});
              } catch (e) {
                reject(e);
              }
            }),
          { locator, left, top, options }
        ),
        new Promise((_, rej) => setTimeout(() => rej(new Error('scrollSC timeout')), timeout + 1000))
      ]);

      if (this.config.scAutoWait && !options.skipAutoWait) {
        await this.waitForSCDone(options);
      }
      
      this.log('scrollSC', `Successfully scrolled: ${locator} to left=${left}, top=${top}`, 'debug');
    } catch (error) {
      this.log('scrollSC', `Failed: ${error.message}`, 'error');
      throw error;
    }
  }

  // dragAndDropSC(): drag from source cell to target cell
  async dragAndDropSC(sourceCellLocator, targetCellLocator, options = {}) {
    try {
      _assertLooksAutoTest(sourceCellLocator);
      this.log('dragAndDropSC', `Preparing drag and drop: ${sourceCellLocator} -> ${targetCellLocator}`, 'info');

      const src = await this.getCellCoordinates(sourceCellLocator, options);

      const tgt = await this.getTargetDropPosition(targetCellLocator, options);

      const dropPosition = options.dropPosition ?? 'before';
      const nudgeY = dropPosition === 'after' ? +1 : -1;
      this.log('dragAndDropSC', `Drop position: ${dropPosition} (nudge: ${nudgeY}px)`, 'info');
      
      const dragDistance = Math.sqrt(Math.pow(tgt.x - src.x, 2) + Math.pow(tgt.y - src.y, 2));
      if (dragDistance > 1000) {
        this.log('dragAndDropSC', `Large drag distance: ${Math.round(dragDistance)}px`, 'warn');
      }

      await this.performDragAndDrop(src, { x: tgt.x, y: tgt.y + nudgeY });

      if (this.config.scAutoWait && !options.skipAutoWait) {
        await this.waitForSCDone(options);
      }
      await this.page.waitForTimeout(150);
      
      this.log('dragAndDropSC', `Successfully dragged from ${sourceCellLocator} to ${targetCellLocator}`, 'debug');
    } catch (error) {
      this.log('dragAndDropSC', `Failed: ${error.message}`, 'error');
      throw error;
    }
  }

  // getTargetDropPosition(): calculate target drop coordinates
  async getTargetDropPosition(targetCellLocator, options = {}) {
    try {
      const gridInfo = await this.page.evaluate((targetLocator) => {
        const isc = globalThis.isc;
        if (!isc?.AutoTest) return { totalRows: 0, targetRow: -1, needsEmptyGridLogic: false };

        const gridMatch = targetLocator.match(/\/\/ListGrid\[ID="([^"]+)"\]/);
        const gridId = gridMatch ? gridMatch[1] : null;
        const grid = gridId ? isc.AutoTest.getObject(`//ListGrid[ID="${gridId}"]`) : null;
        const totalRows = grid?.getTotalRows ? grid.getTotalRows() : 0;

        let targetRow = -1;
        const rowIndexMatch = targetLocator.match(/\/row\[index=(\d+)\]/);
        const rowShortMatch = targetLocator.match(/\/row\[(\d+)\]/);
        if (rowIndexMatch) targetRow = parseInt(rowIndexMatch[1], 10);
        else if (rowShortMatch) targetRow = parseInt(rowShortMatch[1], 10);

        const needsEmptyGridLogic = totalRows === 0 || (targetRow >= 0 && targetRow >= totalRows);
        return { totalRows, targetRow, needsEmptyGridLogic };
      }, targetCellLocator);

      this.log('getTargetDropPosition', `Grid info: ${gridInfo.totalRows} rows, target: ${gridInfo.targetRow}`, 'debug');
      
      if (gridInfo.needsEmptyGridLogic) {
        this.log('getTargetDropPosition', `Empty grid detected (rows: ${gridInfo.totalRows}, target: ${gridInfo.targetRow})`, 'warn');
        const normalizedTarget = this.normalizeEmptyGridLocator(targetCellLocator);
        return await this.getEmptyGridDropPosition(normalizedTarget, options);
      } else {
        this.log('getTargetDropPosition', `Using normal cell coordinates for target`, 'info');
        return await this.getCellCoordinates(targetCellLocator, options);
      }
    } catch (error) {
      this.log('getTargetDropPosition', `Failed: ${error.message}`, 'error');
      throw error;
    }
  }

  // performDragAndDrop(): execute mouse drag and drop sequence
  async performDragAndDrop(src, target) {
    try {
      this.log('performDragAndDrop', `Starting drag from (${Math.round(src.x)}, ${Math.round(src.y)}) to (${Math.round(target.x)}, ${Math.round(target.y)})`, 'info');
      this.log('performDragAndDrop', 'Enabling immediate mouse move for SmartClient', 'debug');
      await this.page.evaluate(() => { if (globalThis.isc?.EH) globalThis.isc.EH.immediateMouseMove = true; });

      await this.page.mouse.move(src.x, src.y);
      await this.page.waitForTimeout(30);

      await this.page.mouse.down();
      await this.page.waitForTimeout(40);

      await this.page.mouse.move(src.x + 6, src.y + 6, { steps: 2 });
      await this.page.waitForTimeout(40);

      await this.page.mouse.move(target.x, target.y, { steps: 10 });
      await this.page.waitForTimeout(30);

      await this.page.mouse.up();
      await this.page.waitForTimeout(40);

      await this.page.evaluate(() => { if (globalThis.isc?.EH) globalThis.isc.EH.immediateMouseMove = null; });
      this.log('performDragAndDrop', 'Drag and drop sequence completed successfully', 'debug');
    } catch (error) {
      this.log('performDragAndDrop', `Failed: ${error.message}`, 'error');
      throw error;
    }
  }

  // normalizeEmptyGridLocator(): convert cell locator to grid body for empty grids
  normalizeEmptyGridLocator(targetLocator) {
    const gridMatch = targetLocator.match(/\/\/ListGrid\[ID="([^"]+)"\]/);
    const colMatch = targetLocator.match(/\/col\[([^\]]+)\]/);
    if (gridMatch && colMatch) return `//ListGrid[ID="${gridMatch[1]}"]/body`;
    return targetLocator;
  }

  // getCellCoordinates(): get center coordinates of element
  async getCellCoordinates(locator, options = {}) {
    try {
      const handle = await this.getSC(locator, { waitStyle: 'element', ...options });
      const box = await handle.boundingBox();
      if (!box) {
        this.log('getCellCoordinates', `Element not visible for coordinates: ${locator}`, 'warn');
        throw new Error(`Element not visible: ${locator}`);
      }
      
      const coords = { raw: box, x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
      this.log('getCellCoordinates', `Element size: ${Math.round(box.width)}x${Math.round(box.height)}px`, 'info');
      this.log('getCellCoordinates', `Resolved coordinates: x=${coords.x}, y=${coords.y}`, 'debug');
      return coords;
    } catch (error) {
      this.log('getCellCoordinates', `Failed: ${error.message}`, 'error');
      throw error;
    }
  }

  // getEmptyGridDropPosition(): calculate drop position for empty grids
  async getEmptyGridDropPosition(gridLocator, options = {}) {
    try {
      const gridHandle = await this.getSC(gridLocator, { waitStyle: 'element', ...options });
      const gridBox = await gridHandle.boundingBox();
      if (!gridBox) {
        this.log('getEmptyGridDropPosition', `Target grid not visible: ${gridLocator}`, 'warn');
        throw new Error(`Target grid not visible: ${gridLocator}`);
      }

      const gridInfo = await this.page.evaluate((loc) => {
        const gridMatch = loc.match(/\/\/ListGrid\[ID="([^"]+)"\]/);
        if (!gridMatch) return { headerHeight: 0, rowHeight: 20, totalRows: 0 };
        const grid = isc.AutoTest.getObject(`//ListGrid[ID="${gridMatch[1]}"]`);
        if (!grid) return { headerHeight: 0, rowHeight: 20, totalRows: 0 };
        return {
          headerHeight: grid.getHeaderHeight ? grid.getHeaderHeight() : 0,
          rowHeight: grid.getRowHeight ? grid.getRowHeight() : 20,
          totalRows: grid.getTotalRows ? grid.getTotalRows() : 0
        };
      }, gridLocator);

      const dropY = gridBox.y + gridInfo.headerHeight + (gridInfo.totalRows > 0 ? gridInfo.totalRows * gridInfo.rowHeight + 5 : 10);
      this.log('getEmptyGridDropPosition', `Grid dimensions: header=${gridInfo.headerHeight}px, row=${gridInfo.rowHeight}px, total=${gridInfo.totalRows}`, 'debug');
      this.log('getEmptyGridDropPosition', `Calculated drop position: x=${gridBox.x + gridBox.width * 0.5}, y=${dropY}`, 'info');
      return { raw: gridBox, x: gridBox.x + gridBox.width * 0.5, y: dropY };
    } catch (error) {
      this.log('getEmptyGridDropPosition', `Failed: ${error.message}`, 'error');
      throw error;
    }
  }

  // enableSC_RPCTimeout(): monitor and log SmartClient RPC performance
  async enableSC_RPCTimeout(logThreshold = 1000, timeoutThreshold = null, options = {}) {
    try {
      this.log('enableSC_RPCTimeout', `Setting up RPC monitoring (log: ${logThreshold}ms, fail: ${timeoutThreshold || 'none'}ms)`, 'info');
      this.log('enableSC_RPCTimeout', 'Enabling SmartClient RPC timing data collection', 'debug');
      await this.page.evaluate(
        ({ logThreshold, timeoutThreshold, options }) => {
          const isc = globalThis.isc;
          if (!isc?.RPCManager?.getTransactionDescription) return;

          isc.RPCManager.setTimingDataEnabled(true);
          isc.RPCManager.addProcessingCompleteCallback(function (txNum) {
            const name = isc.RPCManager.getTransactionDescription(txNum);
            isc.RPCManager.getTimingData(txNum, function (tree) {
              const node = tree.find(options.rpcAction || 'Complete client-server roundtrip');
              const elapsed = node ? node.elapsed : 0;

              const overLog = elapsed >= logThreshold;
              const overFail = timeoutThreshold != null && elapsed > timeoutThreshold;

              if (overLog) {
                const formatted = isc.RPCManager.getFormattedTimingData(
                  txNum,
                  null,
                  null,
                  options.includeClientTimings ?? true,
                  options.includeServerTimings ?? true,
                  options.logDetail === 'all'
                    ? undefined
                    : options.logDetail === 'detailed'
                    ? 5
                    : options.logDetail === 'summary'
                    ? 2
                    : 1
                );
                console.log(`[SC RPC] ${name}\nElapsed ${elapsed}ms >= ${logThreshold}ms\n${formatted}`);
              } else if (options.logSuccess) {
                console.log(`[SC RPC] ${name} OK in ${elapsed}ms`);
              }

              if (overFail || (options.failOnInvalidTimings ?? true) && elapsed <= 0) {
                console.log(`[SC RPC] FAIL ${name} elapsed=${elapsed}`);
              }
            });
          });
        },
        { logThreshold, timeoutThreshold, options }
      );
      this.log('enableSC_RPCTimeout', 'RPC monitoring setup completed', 'debug');
      if (logThreshold < 500) {
        this.log('enableSC_RPCTimeout', `Very low log threshold: ${logThreshold}ms (may generate excessive logs)`, 'warn');
      }
    } catch (error) {
      this.log('enableSC_RPCTimeout', `Failed: ${error.message}`, 'error');
      throw error;
    }
  }

  /** configure(): update SmartClient command configuration */
  configure(cfg) { 
    this.config = { ...this.config, ...cfg }; 
    if (this.config.scLogLevel !== 'silent') {
      this.log('configure', `Updated config: ${JSON.stringify(cfg)}`, 'debug');
    }
  }

  /** setLogLevel(): set logging level */
  setLogLevel(level) {
    this.configure({ scLogLevel: level });
  }

  // getSCObject(): get SmartClient component object by AutoTest locator
  async getSCObject(locator, options = {}) {
    try {
      _assertLooksAutoTest(locator);
      this.log('getSCObject', `Retrieving SmartClient object: ${locator}`, 'info');
      const result = await this.page.evaluate((loc) => globalThis.isc?.AutoTest?.getObject?.(loc) ?? null, locator);
      
      if (this.config.scAutoWait && !options.skipAutoWait) {
        await this.waitForSCDone(options);
      }
      
      if (!result) {
        this.log('getSCObject', `SmartClient object not found: ${locator}`, 'warn');
      }
      this.log('getSCObject', `Retrieved object for ${locator}: ${result ? 'found' : 'null'}`, 'debug');
      return result;
    } catch (error) {
      this.log('getSCObject', `Failed: ${error.message}`, 'error');
      throw error;
    }
  }

  // existsSCElement(): check if element exists by AutoTest locator
  async existsSCElement(locator, options = {}) {
    try {
      _assertLooksAutoTest(locator);
      this.log('existsSCElement', `Checking element existence: ${locator}`, 'info');
      const result = await this.page.evaluate((loc) => !!globalThis.isc?.AutoTest?.getElement?.(loc), locator);
      
      if (this.config.scAutoWait && !options.skipAutoWait) {
        await this.waitForSCDone(options);
      }
      
      if (!result) {
        this.log('existsSCElement', `Element does not exist: ${locator}`, 'warn');
      }
      this.log('existsSCElement', `Element ${locator} exists: ${result}`, 'debug');
      return result;
    } catch (error) {
      this.log('existsSCElement', `Failed: ${error.message}`, 'error');
      throw error;
    }
  }

  // scGetLocatorText(): get text content from element by AutoTest locator
  async scGetLocatorText(locator, options = {}) {
    try {
      _assertLooksAutoTest(locator);
      this.log('scGetLocatorText', `Preparing to extract text: ${locator}`, 'info');
      
      const result = await this.page.evaluate((loc) => {
        const at = globalThis.isc?.AutoTest;
        if (!at) throw new Error('isc.AutoTest not available');
        const el = at.getElement(loc);
        if (!el) throw new Error(`Element not found for locator: ${loc}`);
        return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      }, locator);
      
      if (this.config.scAutoWait && !options.skipAutoWait) {
        await this.waitForSCDone(options);
      }
      
      this.log('scGetLocatorText', `Retrieved text: "${result}" from ${locator}`, 'debug');
      if (!result || result.trim() === '') {
        this.log('scGetLocatorText', `Empty text content from element: ${locator}`, 'warn');
      }
      return result;
    } catch (error) {
      this.log('scGetLocatorText', `Failed: ${error.message}`, 'error');
      throw error;
    }
  }
}

// extendPage(): add SmartClient commands to Playwright page
function extendPage(page) {
  const sc = new SmartClientCommands(page);
  page.getSC = sc.getSC.bind(sc);
  page.waitForSCDone = sc.waitForSCDone.bind(sc);
  page.scrollSC = sc.scrollSC.bind(sc);
  page.clickSC = sc.clickSC.bind(sc);
  page.typeSC = sc.typeSC.bind(sc);
  page.hoverSC = sc.hoverSC.bind(sc);
  page.dragAndDropSC = sc.dragAndDropSC.bind(sc);
  page.enableSC_RPCTimeout = sc.enableSC_RPCTimeout.bind(sc);
  page.configureSC = sc.configure.bind(sc);
  page.setLogLevel = sc.setLogLevel.bind(sc);
  page.getSCTimeout = sc.getSCTimeout.bind(sc);
  page.getSCObject = sc.getSCObject.bind(sc);
  page.existsSCElement = sc.existsSCElement.bind(sc);
  page.scGetLocatorText = sc.scGetLocatorText.bind(sc);
  return page;
}

module.exports = { extendPage, SmartClientCommands };