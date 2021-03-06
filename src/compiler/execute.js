const Thread = require('../engine/thread');
const Timer = require('../util/timer');
const Cast = require('../util/cast');
const log = require('../util/log');

/* eslint-disable no-unused-vars */

const compatibilityLayerBlockUtility = require('./compat-block-utility');

/**
 * The currently running thread.
 * @type {Thread}
 */
let thread;

// All the functions defined here will be available to compiled scripts.
// The JSDoc annotations define the function's contract.
// Most of these functions are only used at runtime by generated scripts. Despite what your editor may say, they are not unused.

let stuckCounter = 0;
/**
 * Determine whether the current tick is likely stuck.
 * This implements similar functionality to the warp timer found in Scratch.
 * @returns {boolean} true if the current tick is likely stuck.
 */
const isStuck = () => {
    // The real time is not checked on every call for performance, as can be a very hot function.
    stuckCounter++;
    if (stuckCounter === 10) {
        stuckCounter = 0;
        return thread.target.runtime.sequencer.timer.timeElapsed() > 500;
    }
    return false;
};

/**
 * Start hats by opcode.
 * @param {string} requestedHat The opcode of the hat to start.
 * @param {*} optMatchFields Fields to match.
 * @returns {Array} A list of threads that were started.
 */
const startHats = (requestedHat, optMatchFields) => {
    const threads = thread.target.runtime.startHats(requestedHat, optMatchFields, undefined);
    return threads;
};

/**
 * Implements "thread waiting", where scripts are halted until all the scripts have finished executing.
 * @param {Array} threads The list of threads.
 */
const waitThreads = function*(threads) {
    const runtime = thread.target.runtime;

    while (true) {
        // determine whether any threads are running
        var anyRunning = false;
        for (var i = 0; i < threads.length; i++) {
            if (runtime.threads.indexOf(threads[i]) !== -1) {
                anyRunning = true;
                break;
            }
        }
        if (!anyRunning) {
            // all threads are finished, can resume
            return;
        }

        var allWaiting = true;
        for (var i = 0; i < threads.length; i++) {
            if (!runtime.isWaitingThread(threads[i])) {
                allWaiting = false;
                break;
            }
        }
        if (allWaiting) {
            thread.status = 3; // STATUS_YIELD_TICK
        }

        yield;
    }
};

/**
 * Wait until a Promise resolves or rejects before continuing.
 * @param {Promise} promise The promise to wait for.
 * @returns {*} the value that the promise resolves to, otherwise undefined if the promise rejects
 */
const waitPromise = function*(promise) {
    // TODO: there's quite a lot going on in engine/execute.js's handlePromise. We should see how much of that matters to us

    const _thread = thread; // need to store reference to current thread, as promise handlers won't be called from the tick loop
    let returnValue = undefined;

    promise
        .then(value => {
            returnValue = value;
            _thread.status = Thread.STATUS_RUNNING;
        })
        .catch(error => {
            _thread.status = Thread.STATUS_RUNNING;
            log.warn('Promise rejected in compiled script:', error);
        });

    // enter STATUS_PROMISE_WAIT and yield, this will stop script execution until the promise handlers reset the thread status
    thread.status = Thread.STATUS_PROMISE_WAIT;
    yield;

    return returnValue;
};

/**
 * Execute a scratch-vm primitive.
 * @param {*} inputs The inputs to pass to the block.
 * @param {function} blockFunction The primitive's function.
 * @returns {*} the value returned by the block, if any.
 */
const executeInCompatibilityLayer = function*(inputs, blockFunction) {
    // reset the stackframe
    // we only ever use one stackframe at a time, so this shouldn't cause issues
    thread.stackFrames[thread.stackFrames.length - 1].reuse(thread.warp > 0);

    const executeBlock = () => {
        compatibilityLayerBlockUtility.thread = thread;
        compatibilityLayerBlockUtility.sequencer = thread.target.runtime.sequencer;
        return blockFunction(inputs, compatibilityLayerBlockUtility);
    };

    const isPromise = (value) => {
        // see engine/execute.js
        return (
            value !== null &&
            typeof value === 'object' &&
            typeof value.then === 'function'
        );
    };

    let returnValue = executeBlock();

    if (isPromise(returnValue)) {
        return yield* waitPromise(returnValue);
    }

    while (thread.status === Thread.STATUS_YIELD || thread.status === Thread.STATUS_YIELD_TICK) {
        // Yielded threads will run next iteration.
        if (thread.status === Thread.STATUS_YIELD) {
            thread.status = Thread.STATUS_RUNNING;
            // Yield back to the event loop when stuck or not in warp mode.
            if (thread.warp === 0 || isStuck()) {
                yield;
            }
        } else {
            // status is STATUS_YIELD_TICK, always yield to the event loop
            yield;
        }

        returnValue = executeBlock();

        if (isPromise(returnValue)) {
            return yield* waitPromise(returnValue);
        }
    }

    // todo: do we have to do anything extra if status is STATUS_DONE?

    return returnValue;
};

/**
 * End the current script.
 */
const retire = () => {
    thread.target.runtime.sequencer.retireThread(thread);
};

/**
 * Scratch cast to boolean.
 * Similar to Cast.toBoolean()
 * @param {*} value The value to cast
 * @returns {boolean} The value cast to a boolean
 */
const toBoolean = value => {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        if (value === '' || value === '0' || value.toLowerCase() === 'false') {
            return false;
        }
        return true;
    }
    return !!value;
};

/**
 * Check if a value is considered whitespace.
 * Similar to Cast.isWhiteSpace()
 * @param {*} val Value to check
 * @returns {boolean} true if the value is whitespace
 */
const isWhiteSpace = val => {
    return val === null || (typeof val === 'string' && val.trim().length === 0);
};

/**
 * Determine if two values are equal.
 * @param {*} v1
 * @param {*} v2
 * @returns {boolean} true if v1 is equal to v2
 */
const compareEqual = (v1, v2) => {
    let n1 = +v1;
    let n2 = +v2;
    if (n1 === 0 && isWhiteSpace(v1)) {
        n1 = NaN;
    } else if (n2 === 0 && isWhiteSpace(v2)) {
        n2 = NaN;
    }
    if (isNaN(n1) || isNaN(n2)) {
        const s1 = ('' + v1).toLowerCase();
        const s2 = ('' + v2).toLowerCase();
        return s1 === s2;
    }
    return n1 === n2;
};

/**
 * Determine if one value is greater than another.
 * @param {*} v1
 * @param {*} v2
 * @returns {boolean} true if v1 is greater than v2
 */
const compareGreaterThan = (v1, v2) => {
    let n1 = +v1;
    let n2 = +v2;
    if (n1 === 0 && isWhiteSpace(v1)) {
        n1 = NaN;
    } else if (n2 === 0 && isWhiteSpace(v2)) {
        n2 = NaN;
    }
    if (isNaN(n1) || isNaN(n2)) {
        const s1 = ('' + v1).toLowerCase();
        const s2 = ('' + v2).toLowerCase();
        return s1 > s2;
    }
    return n1 > n2;
};

/**
 * Determine if one value is less than another.
 * @param {*} v1
 * @param {*} v2
 * @returns {boolean} true if v1 is less than v2
 */
const compareLessThan = (v1, v2) => {
    let n1 = +v1;
    let n2 = +v2;
    if (n1 === 0 && isWhiteSpace(v1)) {
        n1 = NaN;
    } else if (n2 === 0 && isWhiteSpace(v2)) {
        n2 = NaN;
    }
    if (isNaN(n1) || isNaN(n2)) {
        const s1 = ('' + v1).toLowerCase();
        const s2 = ('' + v2).toLowerCase();
        return s1 < s2;
    }
    return n1 < n2;
};

/**
 * Generate a random integer.
 * @param {number} low Lower bound
 * @param {number} high Upper bound
 * @returns {number} A random integer between low and high, inclusive.
 */
const randomInt = (low, high) => {
    return low + Math.floor(Math.random() * ((high + 1) - low));
};

/**
 * Generate a random float.
 * @param {number} low Lower bound
 * @param {number} high Upper bound
 * @returns {number} A random floating point number between low and high.
 */
const randomFloat = (low, high) => {
    return (Math.random() * (high - low)) + low;
};

/**
 * Perform an IO query
 * @param {string} device The name of the device to query
 * @param {string} func The function of the device to query
 * @param {*} [args] The arguments to pass to the device
 * @returns {*} The value returned by the IO device
 */
const ioQuery = (device, func, args) => {
    // We will assume that the device always exists.
    const devObject = thread.target.runtime.ioDevices[device];
    return devObject[func].apply(devObject, args);
};

// nowObj used for timers.
const timerNowObj = {
    now: () => thread.target.runtime.currentMSecs
};

/**
 * Create and start a timer.
 * @returns {Timer} A started timer
 */
const timer = () => {
    const t = new Timer(timerNowObj);
    t.start();
    return t;
};

// This is the "epoch" for the daysSince2000() function.
// Storing this in a variable is faster than constantly recreating it.
const daysSince2000Epoch = new Date(2000, 0, 1);

/**
 * Returns the amount of days since January 1st, 2000.
 * @returns {number} Days since 2000.
 */
const daysSince2000 = () => {
    const today = new Date();
    const dstAdjust = today.getTimezoneOffset() - daysSince2000Epoch.getTimezoneOffset();
    let mSecsSinceStart = today.valueOf() - daysSince2000Epoch.valueOf();
    mSecsSinceStart += ((today.getTimezoneOffset() - dstAdjust) * 60 * 1000);
    return mSecsSinceStart / (24 * 60 * 60 * 1000);
};

/**
 * Determine distance to a sprite or point.
 * @param {string} menu The name of the sprite or location to find.
 * @returns {number} Distance to the point, or 10000 if it cannot be calculated.
 */
const distance = menu => {
    if (thread.target.isStage) return 10000;

    let targetX = 0;
    let targetY = 0;
    if (menu === '_mouse_') {
        targetX = ioQuery('mouse', 'getScratchX');
        targetY = ioQuery('mouse', 'getScratchY');
    } else {
        const distTarget = thread.target.runtime.getSpriteTargetByName(menu);
        if (!distTarget) return 10000;
        targetX = distTarget.x;
        targetY = distTarget.y;
    }

    const dx = thread.target.x - targetX;
    const dy = thread.target.y - targetY;
    return Math.sqrt((dx * dx) + (dy * dy));
};

/**
 * Convert a Scratch list index to a JavaScript list index.
 * "all" is not considered as a list index.
 * Similar to Cast.toListIndex()
 * @param {number} index Scratch list index.
 * @param {number} length Length of the list.
 * @returns {number} 0 based list index, or -1 if invalid.
 */
const listIndex = (index, length) => {
    if (typeof index !== 'number') {
        if (index === 'last') {
            if (length > 0) {
                return length - 1;
            }
            return -1;
        } else if (index === 'random' || index === '*') {
            if (length > 0) {
                return (Math.random() * length) | 0;
            }
            return -1;
        }
        index = +index || 0;
    }
    index = index | 0;
    if (index < 1 || index > length) {
        return -1;
    }
    return index - 1;
};

/**
 * Get a value from a list.
 * @param {Array} list The list
 * @param {*} idx The 1-indexed index in the list.
 * @returns The list item, otherwise empty string if it does not exist.
 */
const listGet = (list, idx) => {
    const index = listIndex(idx, list.length);
    if (index === -1) {
        return '';
    }
    return list[index];
};

/**
 * Replace a value in a list.
 * @param {import('../engine/variable')} list The list
 * @param {*} idx List index, Scratch style.
 * @param {*} value The new value.
 */
const listReplace = (list, idx, value) => {
    const index = listIndex(idx, list.value.length);
    if (index === -1) {
        return;
    }
    list.value[index] = value;
    list._monitorUpToDate = false;
};

/**
 * Insert a value in a list.
 * @param {import('../engine/variable')} list The list.
 * @param {*} idx The Scratch index in the list.
 * @param {*} value The value to insert.
 */
const listInsert = (list, idx, value) => {
    const index = listIndex(idx, list.value.length + 1);
    if (index === -1) {
        return;
    }
    list.value.splice(index, 0, value);
    list._monitorUpToDate = false;
};

/**
 * Delete a value from a list.
 * @param {import('../engine/variable')} list The list.
 * @param {*} idx The Scratch index in the list.
 */
const listDelete = (list, idx) => {
    if (idx === 'all') {
        list.value = [];
        return;
    }
    const index = listIndex(idx, list.value.length);
    if (index === -1) {
        return;
    }
    list.value.splice(index, 1);
    list._monitorUpToDate = false;
};

/**
 * Return whether a list contains a value.
 * @param {import('../engine/variable')} list The list.
 * @param {*} item The value to search for.
 * @returns {boolean} True if the list contains the item
 */
const listContains = (list, item) => {
    // TODO: evaluate whether indexOf is worthwhile here
    if (list.value.indexOf(item) !== -1) {
        return true;
    }
    for (let i = 0; i < list.value.length; i++) {
        if (compareEqual(list.value[i], item)) {
            return true;
        }
    }
    return false;
};

/**
 * Find the 1-indexed index of an item in a list.
 * @param {import('../engine/variable')} list The list.
 * @param {*} item The item to search for
 * @returns {number} The 1-indexed index of the item in the list, otherwise 0
 */
const listIndexOf = (list, item) => {
    for (var i = 0; i < list.value.length; i++) {
        if (compareEqual(list.value[i], item)) {
            return i + 1;
        }
    }
    return 0;
};

/**
 * Get the stringified form of a list.
 * @param {import('../engine/variable')} list The list.
 * @returns {string} Stringified form of the list.
 */
const listContents = list => {
    for (let i = 0; i < list.value.length; i++) {
        const listItem = list.value[i];
        // this is an intentional break from what scratch 3 does to address our automatic string -> number conversions
        // it fixes more than it breaks
        if ((listItem + '').length !== 1) {
            return list.value.join(' ');
        }
    }
    return list.value.join('');
};

/**
 * Convert a color to an RGB list
 * @param {*} color The color value to convert
 * @return {Array.<number>} [r,g,b], values between 0-255.
 */
const colorToList = color => {
    // TODO: remove Cast dependency
    return Cast.toRgbColorList(color);
};

/**
 * Implements Scratch modulo (floored division instead of truncated division)
 * @param {number} n
 * @param {number} modulus
 * @returns {number}
 */
const mod = (n, modulus) => {
    let result = n % modulus;
    if (result / modulus < 0) result += modulus;
    return result;
};

/**
 * Step a compiled thread.
 * @param {Thread} _thread
 */
const execute = (_thread) => {
    thread = _thread;
    _thread.generator.next();
};

/**
 * eval() some JS in the scope of the executor
 * @param {string} source The string to eval()
 * @returns {*} The result of eval()ing the string.
 */
const scopedEval = source => {
    try {
        // eslint-disable-next-line no-eval
        return eval(source);
    } catch (e) {
        log.error('was unable to compile script', source);
        throw e;
    }
};

execute.scopedEval = scopedEval;

module.exports = execute;
