'use strict'; // eslint-disable-line strict

const Logger = require('werelogs').Logger;
const { RedisClient, StatsModel } = require('arsenal').metrics;
const errors = require('arsenal').errors;

const BackbeatConsumer = require('./BackbeatConsumer');
const {
    redisKeys: crrRedisKeys,
    metricsExtension: crrExtension,
} = require('../extensions/replication/constants');
const {
    redisKeys: ingestionRedisKeys,
    metricsExtension: ingestionExtension,
} = require('../extensions/ingestion/constants');

// StatsClient constant defaults for site metrics
const INTERVAL = 300; // 5 minutes;
const EXPIRY = 86400; // 24 hours

// BackbeatConsumer constant defaults
const CONSUMER_FETCH_MAX_BYTES = 5000020;
const CONCURRENCY = 10;

class MetricsConsumer {
    /**
     * @constructor
     * @param {object} rConfig - redis ha configuration
     * @param {string} rConfig.host - redis ha host
     * @param {number} rConfig.port - redis ha port
     * @param {object} mConfig - metrics configurations
     * @param {string} mConfig.topic - metrics topic name
     * @param {object} kafkaConfig - kafka configurations
     * @param {string} kafkaConfig.hosts - kafka hosts
     *   as "host:port[/chroot]"
     * @param {string} id - identifier used for filtering metrics entries
     */
    constructor(rConfig, mConfig, kafkaConfig, id) {
        this.mConfig = mConfig;
        this.kafkaConfig = kafkaConfig;
        this._id = id;

        this._consumer = null;

        this.logger = new Logger('Backbeat:MetricsConsumer');
        const redisClient = new RedisClient(rConfig, this.logger);
        this._statsClient = new StatsModel(redisClient, INTERVAL, EXPIRY);
    }

    start() {
        let consumerReady = false;
        const consumer = new BackbeatConsumer({
            kafka: { hosts: this.kafkaConfig.hosts },
            topic: this.mConfig.topic,
            groupId: `backbeat-metrics-group-${this._id}`,
            concurrency: CONCURRENCY,
            queueProcessor: this.processKafkaEntry.bind(this),
            fetchMaxBytes: CONSUMER_FETCH_MAX_BYTES,
        });
        consumer.on('error', () => {
            if (!consumerReady) {
                this.logger.fatal('error starting metrics consumer');
                process.exit(1);
            }
        });
        consumer.on('ready', () => {
            consumerReady = true;
            consumer.subscribe();
            this._consumer = consumer;
            this.logger.info('metrics processor is ready to consume entries');
        });
    }

    _getRedisKeys(extension) {
        switch (extension) {
            case crrExtension: return crrRedisKeys;
            case ingestionExtension: return ingestionRedisKeys;
            default:
                throw errors.InternalError.customizeDescription(
                    `${extension} is not a valid extension`);
        }
    }

    _sendSiteLevelRequests(data) {
        const { type, site, ops, bytes, extension } = data;
        let redisKeys;
        try {
            redisKeys = this._getRedisKeys(extension);
        } catch (err) {
            return this.logger.error('error consuming metric entry', {
                method: 'MetricsConsumer._sendSiteLevelRequests',
                site,
                type,
            });
        }
        if (type === 'completed') {
            // Pending metrics
            this._sendRequest('decrementKey', site, redisKeys, 'opsPending',
                ops);
            this._sendRequest('decrementKey', site, redisKeys, 'bytesPending',
                bytes);
            // Other metrics
            this._sendRequest('reportNewRequest', site, redisKeys, 'opsDone',
                ops);
            this._sendRequest('reportNewRequest', site, redisKeys, 'bytesDone',
                bytes);
        } else if (type === 'failed') {
            // Pending metrics
            this._sendRequest('decrementKey', site, redisKeys, 'opsPending',
                ops);
            this._sendRequest('decrementKey', site, redisKeys, 'bytesPending',
                bytes);
            // Other metrics
            this._sendRequest('reportNewRequest', site, redisKeys, 'opsFail',
                ops);
            this._sendRequest('reportNewRequest', site, redisKeys, 'bytesFail',
                bytes);
        } else if (type === 'queued') {
            // Pending metrics
            this._sendRequest('incrementKey', site, redisKeys, 'opsPending',
                ops);
            this._sendRequest('incrementKey', site, redisKeys, 'bytesPending',
                bytes);
            // Other metrics
            this._sendRequest('reportNewRequest', site, redisKeys, 'ops', ops);
            this._sendRequest('reportNewRequest', site, redisKeys, 'bytes',
                bytes);
        }
        return undefined;
    }

    _sendObjectLevelRequests(data) {
        const { type, site, bytes, extension,
                bucketName, objectKey, versionId } = data;
        const redisKeys = this._getRedisKeys(extension);
        if (type === 'completed') {
            const key = `${site}:${bucketName}:${objectKey}:` +
                `${versionId}:${redisKeys.objectBytesDone}`;
            this._sendObjectRequest(key, bytes);
        } else if (type === 'queued') {
            const key = `${site}:${bucketName}:${objectKey}:` +
                `${versionId}:${redisKeys.objectBytes}`;
            this._sendObjectRequest(key, bytes);
        }
        return undefined;
    }

    processKafkaEntry(kafkaEntry, done) {
        const log = this.logger.newRequestLogger();
        let data;
        try {
            data = JSON.parse(kafkaEntry.value);
        } catch (err) {
            log.error('error processing metrics entry', {
                method: 'MetricsConsumer.processKafkaEntry',
                error: err,
            });
            log.end();
            return done();
        }
        /*
            data = {
                timestamp: 1509416671977,
                ops: 5,
                bytes: 195,
                extension: 'crr',
                type: 'processed'
            }
        */
        // filter metric entries by service, i.e. 'crr', 'ingestion'
        if (this._id !== data.extension) {
            return done();
        }
        const operationTypes = ['completed', 'failed', 'queued'];
        const isValidType = operationTypes.includes(data.type);
        if (!isValidType) {
            log.error('unknown type field encountered in metrics consumer', {
                method: 'MetricsConsumer.processKafkaEntry',
                dataType: data.type,
                data,
            });
            log.end();
            return done();
        }
        if (data.bucketName && data.objectKey && data.versionId) {
            this._sendObjectLevelRequests(data);
        } else {
            this._sendSiteLevelRequests(data);
        }
        log.end();
        return done();
    }

    _sendRequest(action, site, redisKeys, keyType, value) {
        if (redisKeys[keyType]) {
            this._statsClient[action](`${site}:${redisKeys[keyType]}`,
                value || 0);
        }
    }

    _sendObjectRequest(key, value) {
        this._statsClient.reportNewRequest(key, value);
    }

    close(cb) {
        this._consumer.close(cb);
    }
}

module.exports = MetricsConsumer;
