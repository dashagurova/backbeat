'use strict'; // eslint-disable-line

const util = require('util');

const Logger = require('werelogs').Logger;
const errors = require('arsenal').errors;
const MongoClient = require('arsenal').storage
    .metadata.mongoclient.MongoClientInterface;
const { usersBucket } = require('arsenal').constants;
const { BucketInfo } = require('arsenal').models;
const BackbeatConsumer = require('../../lib/BackbeatConsumer');
const QueueEntry = require('../../lib/models/QueueEntry');
const DeleteOpQueueEntry = require('../../lib/models/DeleteOpQueueEntry');
const BucketQueueEntry = require('../../lib/models/BucketQueueEntry');
const BucketMdQueueEntry = require('../../lib/models/BucketMdQueueEntry');
const ObjectQueueEntry = require('../../lib/models/ObjectQueueEntry');

// Temp testing
const RESET = '\x1b[0m';
// blue
const COLORME = '\x1b[35m';

function logMe(str) {
    console.log(COLORME, str, RESET);
}

// TODO - ADD PREFIX BASED ON SOURCE
// april 6, 2018

/**
 * @class MongoQueueProcessor
 *
 * @classdesc Background task that processes entries from the
 * ingestion for kafka queue and pushes entries to mongo
 */
class MongoQueueProcessor {

    /**
     * @constructor
     * @param {Object} kafkaConfig - kafka configuration object
     * @param {String} kafkaConfig.hosts - list of kafka brokers
     *   as "host:port[,host:port...]"
     * @param {Object} mongoProcessorConfig - mongo processor configuration
     *   object
     * @param {String} mongoProcessorConfig.topic - topic name
     * @param {String} mongoProcessorConfig.groupId - kafka
     *   consumer group ID
     * @param {number} [mongoProcessorConfig.retry.timeoutS] -
     *  retry timeout in secs.
     * @param {number} [mongoProcessorConfig.retry.maxRetries] -
     *  max retries before giving up
     * @param {Object} [mongoProcessorConfig.retry.backoff] -
     *  backoff params
     * @param {number} [mongoProcessorConfig.retry.backoff.min] -
     *  min. backoff in ms.
     * @param {number} [mongoProcessorConfig.retry.backoff.max] -
     *  max. backoff in ms.
     * @param {number} [mongoProcessorConfig.retry.backoff.jitter] -
     *  randomness
     * @param {number} [mongoProcessorConfig.retry.backoff.factor] -
     *  backoff factor
     * @param {Object} mongoClientConfig - config for connecting to mongo
     * @param {String} site - site name
     */
    constructor(kafkaConfig, mongoProcessorConfig, mongoClientConfig, site) {
        this.kafkaConfig = kafkaConfig;
        this.mongoProcessorConfig = mongoProcessorConfig;
        this.mongoClientConfig = mongoClientConfig;
        this.site = site;

        this._consumer = null;
        this.logger =
            new Logger(`Backbeat:Ingestion:MongoProcessor:${this.site}`);
        this.mongoClientConfig.logger = this.logger;
        this._mongoClient = new MongoClient(this.mongoClientConfig);
    }

    /**
     * Start kafka consumer
     *
     * @return {undefined}
     */
    start() {
        this.logger.info('starting mongo queue processor');
        logMe(`PROCESSOR TOPIC: ${this.mongoProcessorConfig.topic}`)
        logMe(this.kafkaConfig.hosts)
        this._mongoClient.setup(err => {
            if (err) {
                this.logger.error('could not connect to MongoDB', { err });
                process.exit(1);
            }
            let consumerReady = false;
            this._consumer = new BackbeatConsumer({
                topic: this.mongoProcessorConfig.topic,
                groupId: `${this.mongoProcessorConfig.groupId}s-${this.site}`,
                kafka: { hosts: this.kafkaConfig.hosts },
                queueProcessor: this.processKafkaEntry.bind(this),
                concurrency: 10,
            });
            this._consumer.on('error', () => {
                if (!consumerReady) {
                    this.logger.fatal('error starting mongo queue processor');
                    process.exit(1);
                }
            });
            this._consumer.on('ready', () => {
                consumerReady = true;
                this._consumer.subscribe();
                this.logger.info('mongo queue processor is ready');
            });
        });
    }

    /**
     * Stop kafka consumer and commit current offset
     *
     * @param {function} done - callback
     * @return {undefined}
     */
    stop(done) {
        if (!this._consumer) {
            return setImmediate(done);
        }
        return this._consumer.close(done);
    }

    _manipulateLocation(entry) {
        const locations = entry.getLocation();
        const editLocations = locations.map(location => {
            const newValues = {
                key: entry.getObjectKey(),
                dataStoreName: 'philz-ring', // require this from populator
                dataStoreType: 'aws_s3',
            }
            if (entry.getVersionId()) {
                console.log(`has versionid.. ${entry.getEncodedVersionId()}`)
                newValues.dataStoreVersionId = entry.getEncodedVersionId();
            }
            return Object.assign({}, location, newValues);
        });
        entry.setLocation(editLocations);
    }

    _manipulateOwner(entry) {
        entry.setOwnerDisplayName('felipe')
        entry.setOwnerId(
            '117d39428f838cb5ac64ffd998f27e44167047a46e6504057b50ed484ae6c5de')
    }

    _manipulateKey(entry) {
        //
    }

    /**
     * Put kafka queue entry into mongo
     *
     * @param {object} kafkaEntry - entry generated by ingestion populator
     * @param {string} kafkaEntry.key - kafka entry key
     * @param {string} kafkaEntry.value - kafka entry value
     * @param {function} done - callback function
     * @return {undefined}
     */
    processKafkaEntry(kafkaEntry, done) {
        logMe('ENTER processKafkaEntry')
        const sourceEntry = QueueEntry.createFromKafkaEntry(kafkaEntry);
        if (sourceEntry.error) {
            logMe('GOT ERROR ON PROCESSOR SIDE')
            this.logger.error('error processing source entry',
                              { error: sourceEntry.error });
            return process.nextTick(() => done(errors.InternalError));
        }

        logMe('IN PROCESSOR SIDE')
        logMe(JSON.stringify(sourceEntry))

        // logMe(`==== CHECK: ${this.site}`)
        // logMe(JSON.stringify(util.inspect(kafkaEntry, { depth: 4 })))

        // TODO-FIX:
        // Depends on the filter data. Need a way of determining the
        // zenko bucket.
        // if entry is for another site, simply skip/ignore
        // if (this.site !== kafkaEntry.bucket) {
        //     return process.nextTick(done);
        // }

        if (sourceEntry instanceof DeleteOpQueueEntry) {
            logMe('--> DELETE OP QUEUE ENTRY <--')
            const bucket = sourceEntry.getBucket();
            const key = sourceEntry.getObjectVersionedKey();
            // Always call deleteObject with version params undefined so
            // that mongoClient will use deleteObjectNoVer which just deletes
            // the object without further manipulation/actions.
            // S3 takes care of the versioning logic so consuming the queue
            // is sufficient to replay the version logic in the consumer.
            return this._mongoClient.deleteObject(bucket, key, undefined,
                this.logger, err => {
                    if (err) {
                        this.logger.error('error deleting object metadata ' +
                        'from mongo', { bucket, key, error: err.message });
                        return done(err);
                    }
                    this.logger.info('object metadata deleted from mongo',
                    { bucket, key });
                    return done();
                });
        }
        if (sourceEntry instanceof ObjectQueueEntry) {
            logMe('--> OBJECT QUEUE ENTRY <--')

            // TODO:
            //
            const bucket = sourceEntry.getBucket();
            // always use versioned key so putting full version state to mongo
            const key = sourceEntry.getObjectVersionedKey();

            this._manipulateLocation(sourceEntry);
            this._manipulateOwner(sourceEntry);

            const objVal = sourceEntry.getValue();

            // Always call putObject with version params undefined so
            // that mongoClient will use putObjectNoVer which just puts
            // the object without further manipulation/actions.
            // S3 takes care of the versioning logic so consuming the queue
            // is sufficient to replay the version logic in the consumer.
            return this._mongoClient.putObject(bucket, key, objVal, undefined,
                this.logger, err => {
                    if (err) {
                        this.logger.error('error putting object metadata ' +
                        'to mongo', { error: err });
                        return done(err);
                    }
                    this.logger.info('object metadata put to mongo',
                    { key });
                    return done();
                });
        }
        if (sourceEntry instanceof BucketMdQueueEntry) {
            logMe('WARN')
            logMe('--> BUCKET MD QUEUE ENTRY <--')
        //     const masterBucket = sourceEntry.getMasterBucket();
        //     const instanceBucket = sourceEntry.getInstanceBucket();
        //     const val = sourceEntry.getValue();
        //     return this._mongoClient.putObject(masterBucket,
        //         instanceBucket, val, undefined,
        //         this.logger, err => {
        //             if (err) {
        //                 this.logger.error('error putting bucket ' +
        //                 'metadata to mongo',
        //                 { error: err.message, masterBucket, instanceBucket });
        //                 return done(err);
        //             }
        //             this.logger.info('bucket metadata put into mongo',
        //             { masterBucket, instanceBucket });
        //             return done();
        //         });
        }
        if (sourceEntry instanceof BucketQueueEntry) {
            logMe('WARN')
            logMe('--> BUCKET QUEUE ENTRY <--')
        //     const bucketOwnerKey = sourceEntry.getBucketOwnerKey();
        //     const val = sourceEntry.getValue();
        //     return this._mongoClient.putObject(usersBucket,
        //         bucketOwnerKey, val, undefined,
        //         this.logger, err => {
        //             if (err) {
        //                 this.logger.error('error putting bucket entry to mongo',
        //                 { error: err.message, bucketOwnerKey });
        //                 return done(err);
        //             }
        //             this.logger.info('successfully put bucket entry to mongo',
        //             { bucketOwnerKey });
        //             return done();
        //         });
        }
        this.logger.warn('skipping unknown source entry',
                            { entry: sourceEntry.getLogInfo() });
        return process.nextTick(done);
    }

    isReady() {
        return this._consumer && this._consumer.isReady();
    }
}

module.exports = MongoQueueProcessor;
