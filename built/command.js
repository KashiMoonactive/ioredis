"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fbuffer = require("flexbuffer");
const commands = require("redis-commands");
const calculateSlot = require("cluster-key-slot");
const asCallback = require("standard-as-callback");
const utils_1 = require("./utils");
const lodash_1 = require("./utils/lodash");
const promiseContainer_1 = require("./promiseContainer");
const logger_1 = require("./logger");
/**
 * Command instance
 *
 * It's rare that you need to create a Command instance yourself.
 *
 * @export
 * @class Command
 *
 * @example
 * ```js
 * var infoCommand = new Command('info', null, function (err, result) {
 *   console.log('result', result);
 * });
 *
 * redis.sendCommand(infoCommand);
 *
 * // When no callback provided, Command instance will have a `promise` property,
 * // which will resolve/reject with the result of the command.
 * var getCommand = new Command('get', ['foo']);
 * getCommand.promise.then(function (result) {
 *   console.log('result', result);
 * });
 * ```
 * @see {@link Redis#sendCommand} which can send a Command instance to Redis
 */
class Command {
    /**
     * Creates an instance of Command.
     * @param {string} name Command name
     * @param {(Array<string | Buffer | number>)} [args=[]] An array of command arguments
     * @param {ICommandOptions} [options={}]
     * @param {Function} [callback] The callback that handles the response.
     * If omit, the response will be handled via Promise
     * @memberof Command
     */
    constructor(name, args = [], options = {}, callback) {
        this.name = name;
        this.transformed = false;
        this.isCustomCommand = false;
        this.replyEncoding = options.replyEncoding;
        this.errorStack = options.errorStack;
        this.id = null;
        this.args = lodash_1.flatten(args);
        this.callback = callback;
        this.initPromise();
        if (options.keyPrefix) {
            this._iterateKeys((key) => (options.keyPrefix + key));
        }
    }
    static getFlagMap() {
        if (!this.flagMap) {
            this.flagMap = Object.keys(Command.FLAGS).reduce((map, flagName) => {
                map[flagName] = {};
                Command.FLAGS[flagName].forEach((commandName) => {
                    map[flagName][commandName] = true;
                });
                return map;
            }, {});
        }
        return this.flagMap;
    }
    /**
     * Check whether the command has the flag
     *
     * @param {string} flagName
     * @param {string} commandName
     * @return {boolean}
     */
    static checkFlag(flagName, commandName) {
        return !!this.getFlagMap()[flagName][commandName];
    }
    static setArgumentTransformer(name, func) {
        this._transformer.argument[name] = func;
    }
    static setReplyTransformer(name, func) {
        this._transformer.reply[name] = func;
    }
    initPromise() {
        const Promise = promiseContainer_1.get();
        const promise = new Promise((resolve, reject) => {
            if (!this.transformed) {
                this.transformed = true;
                const transformer = Command._transformer.argument[this.name];
                if (transformer) {
                    this.args = transformer(this.args);
                }
                this.stringifyArguments();
            }
            this.resolve = this._convertValue(resolve);
            if (this.errorStack) {
                this.reject = (err) => {
                    reject(utils_1.optimizeErrorStack(err, this.errorStack, __dirname));
                };
            }
            else {
                this.reject = reject;
            }
        });
        this.promise = asCallback(promise, this.callback);
    }
    getSlot() {
        if (typeof this.slot === 'undefined') {
            const key = this.getKeys()[0];
            this.slot = key == null ? null : calculateSlot(key);
        }
        return this.slot;
    }
    getKeys() {
        return this._iterateKeys();
    }
    /**
     * Iterate through the command arguments that are considered keys.
     *
     * @param {Function} [transform=(key) => key] The transformation that should be applied to
     * each key. The transformations will persist.
     * @returns {string[]} The keys of the command.
     * @memberof Command
     */
    _iterateKeys(transform = (key) => key) {
        if (typeof this.keys === 'undefined') {
            this.keys = [];
            if (commands.exists(this.name)) {
                const keyIndexes = commands.getKeyIndexes(this.name, this.args);
                for (const index of keyIndexes) {
                    this.args[index] = transform(this.args[index]);
                    this.keys.push(this.args[index]);
                }
            }
        }
        return this.keys;
    }
    /**
     * Convert command to writable buffer or string
     *
     * @return {string|Buffer}
     * @see {@link Redis#sendCommand}
     * @public
     */
    toWritable() {
        logger_1.logData('toWritable', { args: this.args, command: this.name, slot: this.slot, now: Date.now(), redisId: this.id });
        let bufferMode = false;
        for (const arg of this.args) {
            if (arg instanceof Buffer) {
                bufferMode = true;
                break;
            }
        }
        let result;
        let commandStr = '*' + (this.args.length + 1) + '\r\n$' + this.name.length + '\r\n' + this.name + '\r\n';
        if (bufferMode) {
            const resultBuffer = new fbuffer.FlexBuffer(0);
            resultBuffer.write(commandStr);
            for (const arg of this.args) {
                if (arg instanceof Buffer) {
                    if (arg.length === 0) {
                        resultBuffer.write('$0\r\n\r\n');
                    }
                    else {
                        resultBuffer.write('$' + arg.length + '\r\n');
                        resultBuffer.write(arg);
                        resultBuffer.write('\r\n');
                    }
                }
                else {
                    resultBuffer.write('$' + Buffer.byteLength(arg) + '\r\n' + arg + '\r\n');
                }
            }
            result = resultBuffer.getBuffer();
        }
        else {
            result = commandStr;
            for (const arg of this.args) {
                result += '$' + Buffer.byteLength(arg) + '\r\n' + arg + '\r\n';
            }
        }
        return result;
    }
    setRedisId(id) {
        this.id = id;
    }
    stringifyArguments() {
        for (let i = 0; i < this.args.length; ++i) {
            const arg = this.args[i];
            if (!(arg instanceof Buffer) && typeof arg !== 'string') {
                this.args[i] = utils_1.toArg(arg);
            }
        }
    }
    /**
     * Convert the value from buffer to the target encoding.
     *
     * @private
     * @param {Function} resolve The resolve function of the Promise
     * @returns {Function} A funtion to transform and resolve a value
     * @memberof Command
     */
    _convertValue(resolve) {
        return (value) => {
            try {
                resolve(this.transformReply(value));
            }
            catch (err) {
                this.reject(err);
            }
            return this.promise;
        };
    }
    /**
     * Convert buffer/buffer[] to string/string[],
     * and apply reply transformer.
     *
     * @memberof Command
     */
    transformReply(result) {
        if (this.replyEncoding) {
            result = utils_1.convertBufferToString(result, this.replyEncoding);
        }
        const transformer = Command._transformer.reply[this.name];
        if (transformer) {
            result = transformer(result);
        }
        return result;
    }
}
Command.FLAGS = {
    // Commands that can be processed when client is in the subscriber mode
    VALID_IN_SUBSCRIBER_MODE: ['subscribe', 'psubscribe', 'unsubscribe', 'punsubscribe', 'ping', 'quit'],
    // Commands that are valid in monitor mode
    VALID_IN_MONITOR_MODE: ['monitor', 'auth'],
    // Commands that will turn current connection into subscriber mode
    ENTER_SUBSCRIBER_MODE: ['subscribe', 'psubscribe'],
    // Commands that may make current connection quit subscriber mode
    EXIT_SUBSCRIBER_MODE: ['unsubscribe', 'punsubscribe'],
    // Commands that will make client disconnect from server TODO shutdown?
    WILL_DISCONNECT: ['quit']
};
Command._transformer = {
    argument: {},
    reply: {}
};
exports.default = Command;
const msetArgumentTransformer = function (args) {
    if (args.length === 1) {
        if (typeof Map !== 'undefined' && args[0] instanceof Map) {
            return utils_1.convertMapToArray(args[0]);
        }
        if (typeof args[0] === 'object' && args[0] !== null) {
            return utils_1.convertObjectToArray(args[0]);
        }
    }
    return args;
};
Command.setArgumentTransformer('mset', msetArgumentTransformer);
Command.setArgumentTransformer('msetnx', msetArgumentTransformer);
Command.setArgumentTransformer('hmset', function (args) {
    if (args.length === 2) {
        if (typeof Map !== 'undefined' && args[1] instanceof Map) {
            return [args[0]].concat(utils_1.convertMapToArray(args[1]));
        }
        if (typeof args[1] === 'object' && args[1] !== null) {
            return [args[0]].concat(utils_1.convertObjectToArray(args[1]));
        }
    }
    return args;
});
Command.setReplyTransformer('hgetall', function (result) {
    if (Array.isArray(result)) {
        var obj = {};
        for (var i = 0; i < result.length; i += 2) {
            obj[result[i]] = result[i + 1];
        }
        return obj;
    }
    return result;
});
