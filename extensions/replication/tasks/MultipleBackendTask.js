const async = require('async');
const uuid = require('uuid/v4');

const errors = require('arsenal').errors;
const jsutil = require('arsenal').jsutil;
const ObjectMD = require('arsenal').models.ObjectMD;
const ObjectMDLocation = require('arsenal').models.ObjectMDLocation;
const BackbeatMetadataProxy = require('../../../lib/BackbeatMetadataProxy');
const ObjectQueueEntry = require('../../../lib/models/ObjectQueueEntry');
const ActionQueueEntry = require('../../../lib/models/ActionQueueEntry');

const ReplicateObject = require('./ReplicateObject');
const { attachReqUids } = require('../../../lib/clients/utils');
const getExtMetrics = require('../utils/getExtMetrics');
const { metricsExtension, metricsTypeQueued, metricsTypeCompleted } =
    require('../constants');

const MPU_CONC_LIMIT = 10;
const MPU_GCP_MAX_PARTS = 1024;

class MultipleBackendTask extends ReplicateObject {

    _getReplicationEndpointType() {
        const replicationEndpoint = this.destConfig.bootstrapList
            .find(endpoint => endpoint.site === this.site);
        return replicationEndpoint.type;
    }

    _getBucketReplicationConfiguration(entry, log, cb) {
        this.retry({
            actionDesc: 'get bucket replication configuration',
            logFields: { entry: entry.getLogInfo() },
            actionFunc: done => this._getBucketReplicationConfigurationOnce(
                entry, log, done),
            // Rely on AWS SDK notion of retryable error to decide if
            // we should set the entry replication status to FAILED
            // (non retryable) or retry later.
            shouldRetryFunc: err => err.retryable,
            log,
        }, cb);
    }

    _getBucketReplicationConfigurationOnce(entry, log, cb) {
        log.debug('getting bucket replication', { entry: entry.getLogInfo() });
        let errMessage;

        const req = this.S3source.getBucketReplication({
            Bucket: entry.getBucket(),
        });
        attachReqUids(req, log);
        return req.send((err, data) => {
            if (err) {
                log.error('error getting replication configuration from S3', {
                    method: 'MultipleBackendTask.' +
                        '_getBucketReplicationConfigurationOnce',
                    entry: entry.getLogInfo(),
                    origin: 'source',
                    peer: this.sourceConfig.s3,
                    error: err.message,
                    httpStatus: err.statusCode,
                });
                // eslint-disable-next-line no-param-reassign
                err.origin = 'source';
                return cb(err);
            }
            const replicationEnabled = data.ReplicationConfiguration.Rules
                .some(rule => rule.Status === 'Enabled' &&
                    entry.getObjectKey().startsWith(rule.Prefix));
            if (!replicationEnabled) {
                errMessage = 'replication disabled for object';
                log.debug(errMessage, {
                    method: 'MultipleBackendTask.' +
                        '_getBucketReplicationConfigurationOnce',
                    entry: entry.getLogInfo(),
                });
                return cb(errors.PreconditionFailed.customizeDescription(
                    errMessage));
            }
            return cb();
        });
    }

    _fetchSourceMD(sourceEntry, log, cb) {
        const params = {
            bucket: sourceEntry.getBucket(),
            objectKey: sourceEntry.getObjectKey(),
            encodedVersionId: sourceEntry.getEncodedVersionId(),
        };
        return this.backbeatSourceProxy.getMetadata(
        params, log, (err, blob) => {
            if (err) {
                log.error('error getting metadata blob from S3', {
                    method: 'MultipleBackendTask._fetchSourceMD',
                    error: err,
                });
                return cb(err);
            }
            const res = ObjectMD.createFromBlob(blob.Body);
            if (res.error) {
                log.error('error parsing metadata blob', {
                    error: res.error,
                    method: 'MultipleBackendTask._fetchSourceMD',
                });
                return cb(errors.InternalError.
                    customizeDescription('error parsing metadata blob'));
            }
            return cb(null, res.result);
        });
    }

    /**
     * This is a retry wrapper for calling _getRangeAndPutMPUPartOnce.
     * @param {ObjectQueueEntry} sourceEntry - The source object entry
     * @param {String} range - The range to get an object with
     * @param {Number} partNumber - The part number for the current part
     * @param {String} uploadId - The upload ID of the initiated MPU
     * @param {Werelogs} log - The logger instance
     * @param {Function} cb - The callback to call
     * @return {undefined}
     */
    _getRangeAndPutMPUPart(sourceEntry, range, partNumber, uploadId,
        log, cb) {
        this.retry({
            actionDesc: 'stream part data',
            logFields: { entry: sourceEntry.getLogInfo() },
            actionFunc: done => this._getRangeAndPutMPUPartOnce(sourceEntry,
                range, partNumber, uploadId, log, done),
            shouldRetryFunc: err => err.retryable,
            log,
        }, cb);
    }

    /**
     * Get the ranged object, calculate the data's size, then put the part.
     * @param {ObjectQueueEntry} sourceEntry - The source object entry
     * @param {Object} [range] - The range to get an object with
     * @param {Number} range.start - The start byte range
     * @param {Number} range.end - The end byte range
     * @param {Number} partNumber - The part number for the current part
     * @param {String} uploadId - The upload ID of the initiated MPU
     * @param {Werelogs} log - The logger instance
     * @param {Function} done - The callback to call
     * @return {undefined}
     */
    _getRangeAndPutMPUPartOnce(sourceEntry, range, partNumber,
        uploadId, log, done) {
        log.debug('getting object range', {
            entry: sourceEntry.getLogInfo(),
            range,
        });
        const doneOnce = jsutil.once(done);
        // A 0-byte object has no range, otherwise range is inclusive.
        const size = range ? range.end - range.start + 1 : 0;
        let sourceReq = null;
        if (size !== 0) {
            sourceReq = this.backbeatSource.getObject({
                Bucket: sourceEntry.getBucket(),
                Key: sourceEntry.getObjectKey(),
                VersionId: sourceEntry.getEncodedVersionId(),
                // A 0-byte part has no range.
                Range: range && `bytes=${range.start}-${range.end}`,
                LocationConstraint: sourceEntry.getDataStoreName(),
            });
        }
        return this._putMPUPart(sourceEntry, sourceReq, size,
            uploadId, partNumber, log, doneOnce);
    }

    /**
     * Wrapper for aborting an MPU which uses exponential backoff retry.
     * @param {ObjectQueueEntry} sourceEntry - The source object entry
     * @param {String} uploadId - The MPU upload ID to abort
     * @param {Werelogs} log - The logger instance
     * @param {Function} cb - The callback to call
     * @return {undefined}
     */
    _multipleBackendAbortMPU(sourceEntry, uploadId, log, cb) {
        this.retry({
            actionDesc: 'abort multipart upload',
            logFields: { entry: sourceEntry.getLogInfo() },
            actionFunc: done => this._multipleBackendAbortMPUOnce(sourceEntry,
                uploadId, log, done),
            shouldRetryFunc: err => err.retryable,
            log,
        }, cb);
    }

    /**
     * Attempt to abort the given MPU on the source.
     * @param {ObjectQueueEntry} sourceEntry - The source object entry
     * @param {String} uploadId - The MPU upload ID to abort
     * @param {Werelogs} log - The logger instance
     * @param {Function} cb - The callback to call
     * @return {undefined}
     */
    _multipleBackendAbortMPUOnce(sourceEntry, uploadId, log, cb) {
        log.debug('aborting multipart upload', {
            entry: sourceEntry.getLogInfo(),
            uploadId,
        });
        const doneOnce = jsutil.once(cb);
        const destReq = this.backbeatSource.multipleBackendAbortMPU({
            Bucket: sourceEntry.getBucket(),
            Key: sourceEntry.getObjectKey(),
            StorageType: sourceEntry.getReplicationStorageType(),
            StorageClass: this.site,
            UploadId: uploadId,
        });
        attachReqUids(destReq, log);
        return destReq.send(err => {
            if (err) {
                // eslint-disable-next-line no-param-reassign
                err.origin = 'source';
                log.error('an error occurred aborting multipart upload', {
                    method: 'MultipleBackendTask._multipleBackendAbortMPUOnce',
                    entry: sourceEntry.getLogInfo(),
                    origin: 'source',
                    peer: this.destBackbeatHost,
                    error: err.message,
                });
                return doneOnce(err);
            }
            return doneOnce();
        });
    }

   /**
    * Perform a multipart upload.
    * @param {ObjectQueueEntry} sourceEntry - The source object entry
    * @param {String} uploadId - The upload ID of the initiated MPU
    * @param {Stream} data - The incoming message of the get request
    * @param {Werelogs} log - The logger instance
    * @param {Function} doneOnce - The callback to call
    * @return {undefined}
    */
    _completeMPU(sourceEntry, uploadId, data, log, doneOnce) {
        const destReq = this.backbeatSource.multipleBackendCompleteMPU({
            Bucket: sourceEntry.getBucket(),
            Key: sourceEntry.getObjectKey(),
            StorageType: sourceEntry.getReplicationStorageType(),
            StorageClass: this.site,
            VersionId: sourceEntry.getEncodedVersionId(),
            UserMetaData: sourceEntry.getUserMetadata(),
            ContentType: sourceEntry.getContentType(),
            CacheControl: sourceEntry.getCacheControl() || undefined,
            ContentDisposition: sourceEntry.getContentDisposition() ||
                undefined,
            ContentEncoding: sourceEntry.getContentEncoding() ||
                undefined,
            UploadId: uploadId,
            Body: JSON.stringify(data),
        });
        attachReqUids(destReq, log);
        return destReq.send((err, data) => {
            if (err) {
                // eslint-disable-next-line no-param-reassign
                err.origin = 'source';
                log.error('an error occurred on completing MPU to S3', {
                    method: 'MultipleBackendTask._completeMPU',
                    entry: sourceEntry.getLogInfo(),
                    origin: 'target',
                    peer: this.destBackbeatHost,
                    error: err.message,
                });
                return doneOnce(err);
            }
            sourceEntry.setReplicationSiteDataStoreVersionId(this.site,
                data.versionId);
            return doneOnce();
        });
    }

    /**
     * Get the ranged object, calculate the data's size, then put the part.
     * @param {ObjectQueueEntry} sourceEntry - The source object entry
     * @param {AWS.Request} sourceReq - The source request for getting data
     * @param {Number} size - The size of the content
     * @param {String} uploadId - The upload ID of the initiated MPU
     * @param {Number} partNumber - The part number of the part
     * @param {Werelogs} log - The logger instance
     * @param {Function} doneOnce - The callback to call
     * @return {undefined}
     */
    _putMPUPart(sourceEntry, sourceReq, size, uploadId, partNumber,
        log, doneOnce) {
        let incomingMsg = null;
        if (sourceReq) {
            attachReqUids(sourceReq, log);
            sourceReq.on('error', err => {
                // eslint-disable-next-line no-param-reassign
                err.origin = 'source';
                if (err.statusCode === 404) {
                    return doneOnce(err);
                }
                log.error('an error occurred on getObject from S3', {
                    method: 'MultipleBackendTask._putMPUPart',
                    entry: sourceEntry.getLogInfo(),
                    origin: 'source',
                    peer: this.sourceConfig.s3,
                    error: err.message,
                    httpStatus: err.statusCode,
                });
                return doneOnce(err);
            });
            incomingMsg = sourceReq.createReadStream();
            incomingMsg.on('error', err => {
                if (err.statusCode === 404) {
                    return doneOnce(errors.ObjNotFound);
                }
                // eslint-disable-next-line no-param-reassign
                err.origin = 'source';
                log.error('an error occurred when streaming data from S3', {
                    entry: sourceEntry.getLogInfo(),
                    method: 'MultipleBackendTask._putMPUPart',
                    origin: 'source',
                    peer: this.sourceConfig.s3,
                    error: err.message,
                });
                return doneOnce(err);
            });
            log.debug('putting data', { entry: sourceEntry.getLogInfo() });
        }

        const destReq = this.backbeatSource.multipleBackendPutMPUPart({
            Bucket: sourceEntry.getBucket(),
            Key: sourceEntry.getObjectKey(),
            ContentLength: size,
            StorageType: sourceEntry.getReplicationStorageType(),
            StorageClass: this.site,
            PartNumber: partNumber,
            UploadId: uploadId,
            Body: incomingMsg,
        });
        attachReqUids(destReq, log);
        return destReq.send((err, data) => {
            if (err) {
                // eslint-disable-next-line no-param-reassign
                err.origin = 'source';
                log.error('an error occurred on putting MPU part to S3', {
                    method: 'MultipleBackendTask._putMPUPart',
                    entry: sourceEntry.getLogInfo(),
                    origin: 'target',
                    peer: this.destBackbeatHost,
                    error: err.message,
                });
                return doneOnce(err);
            }
            const extMetrics = getExtMetrics(this.site, size, sourceEntry);
            this.mProducer.publishMetrics(extMetrics,
                metricsTypeCompleted, metricsExtension, () => {});
            return doneOnce(null, data);
        });
    }

    _getAndPutMultipartUpload(sourceEntry, part, uploadId, log, cb) {
        this.retry({
            actionDesc: 'stream part data',
            logFields: { entry: sourceEntry.getLogInfo() },
            actionFunc: done => this._getAndPutMultipartUploadOnce(sourceEntry,
                part, uploadId, log, done),
            shouldRetryFunc: err => err.retryable,
            log,
        }, cb);
    }

    _initiateMPU(sourceEntry, log, cb) {
        // If using Azure backend, create a unique ID to use as the block ID.
        if (this._getReplicationEndpointType() === 'azure') {
            const uploadId = uuid().replace(/-/g, '');
            return setImmediate(() => cb(null, uploadId));
        }
        const destReq = this.backbeatSource.multipleBackendInitiateMPU({
            Bucket: sourceEntry.getBucket(),
            Key: sourceEntry.getObjectKey(),
            StorageType: sourceEntry.getReplicationStorageType(),
            StorageClass: this.site,
            VersionId: sourceEntry.getEncodedVersionId(),
            UserMetaData: sourceEntry.getUserMetadata(),
            ContentType: sourceEntry.getContentType(),
            CacheControl: sourceEntry.getCacheControl() || undefined,
            ContentDisposition:
                sourceEntry.getContentDisposition() || undefined,
            ContentEncoding: sourceEntry.getContentEncoding() || undefined,
        });
        attachReqUids(destReq, log);
        return destReq.send((err, data) => {
            if (err) {
                // eslint-disable-next-line no-param-reassign
                err.origin = 'source';
                log.error('an error occurred on initating MPU to S3', {
                    method: 'MultipleBackendTask._initiateMPU',
                    entry: sourceEntry.getLogInfo(),
                    origin: 'target',
                    peer: this.destBackbeatHost,
                    error: err.message,
                });
                return cb(err);
            }
            return cb(null, data.uploadId);
        });
    }

    /**
     * Get a byte range size for an object of the given content length, such
     * that the range count does not exceed 1024 elements (i.e.
     * MPU_GCP_MAX_PARTS).
     * @param {Number} contentLen - The content length of the whole object
     * @return {Number} The range size to use
     */
    _getGCPRangeSize(contentLen) {
        let rangeSize = this._getRangeSize(contentLen);
        if (contentLen / rangeSize > MPU_GCP_MAX_PARTS) {
            const pow =
                Math.pow(2, Math.ceil(Math.log(contentLen) / Math.log(2)));
            rangeSize = Math.ceil(pow / MPU_GCP_MAX_PARTS);
        }
        return rangeSize;
    }

    /**
     * Get a byte range size for an object of the given content length, such
     * that the range size sums to the content length when multiplied by a value
     * between 1 and 10000. This has the effect of creating MPU parts of the
     * given range size. This method also optimizes for the subsequent range
     * requests by returning a range size that is an interval of MB or GB.
     * @param {Number} contentLen - The content length of the whole object
     * @return {Number} The range size to use
     */
    _getRangeSize(contentLen) {
        let rangeSize = (1024 * 1024) * 16; // Default 16MB part size.
        if (contentLen <= rangeSize) {
            return contentLen;
        }
        // Target creation of an MPU that is between a 2 and 1000 parts.
        while (contentLen / rangeSize > 1000) {
            // When given a very large object we want to allow use of up to 10K
            // parts, so we limit the part size to 512MB here.
            if (rangeSize >= (1024 * 1024) * 512) {
                break;
            }
            rangeSize *= 2;
        }
        // If the object is large enough to exceed 10K parts of 512MB, then at
        // this point we need to increase the part size such that the largest
        // object size of 5TB can be accounted for.
        while (contentLen / rangeSize > 10000) {
            rangeSize *= 2;
        }
        return rangeSize;
    }

    /**
     * Get byte ranges for an object of the given content length, such that the
     * range count does not exceed 1024 parts if replicating to GCP or does not
     * exceed 10000 parts otherwise.
     * @param {Number} contentLen - The content length of the whole object
     * @param {Boolean} isGCP - Whether the object is being replicated to GCP
     * @return {Array} The array of byte ranges.
     */
    _getRanges(contentLen, isGCP) {
        if (contentLen === 0) {
            // 0-byte object has no range. However we still want to put a single
            // part so the range in the subsequent GET request is undefined.
            return [null];
        }
        const size = isGCP ?
            this._getGCPRangeSize(contentLen) : this._getRangeSize(contentLen);
        const ranges = [];
        let start = 0;
        let end = 0;
        while (end < contentLen - 1) {
            end = start + size - 1;
            if (end < contentLen - 1) {
                ranges.push({ start, end });
                start = end + 1;
            }
        }
        ranges.push({ start, end: contentLen - 1 });
        return ranges;
    }

    /**
     * Perform a multipart upload using ranged get object requests.
     * @param {ObjectQueueEntry} sourceEntry - The source object entry
     * @param {String} uploadId - The upload ID of the initiated MPU
     * @param {Werelogs} log - The logger instance
     * @param {Function} doneOnce - The callback to call
     * @return {undefined}
     */
    _completeRangedMPU(sourceEntry, uploadId, log, doneOnce) {
        const isGCP = this._getReplicationEndpointType() === 'gcp';
        const isAzure = this._getReplicationEndpointType() === 'azure';
        const ranges = this._getRanges(sourceEntry.getContentLength(), isGCP);
        return async.timesLimit(ranges.length, MPU_CONC_LIMIT, (n, next) =>
            this._getRangeAndPutMPUPart(sourceEntry, ranges[n],
                n + 1, uploadId, log, (err, data) => {
                    if (err) {
                        if (sourceEntry.getReplicationIsNFS()) {
                            const putPartErr = err;
                            return this._checkMPUState(sourceEntry,
                            uploadId, log, err => {
                                if (err) {
                                    return next(err);
                                }
                                return next(putPartErr);
                            });
                        }
                        return next(err);
                    }
                    const res = {
                        PartNumber: [data.partNumber],
                        ETag: [data.ETag],
                    };
                    if (isAzure) {
                        res.NumberSubParts = [data.numberSubParts];
                    }
                    if (sourceEntry.getReplicationIsNFS()) {
                        // Check that the object state did not change upon
                        // succesffuly putting part data to the destination.
                        return this._checkMPUState(sourceEntry,
                            uploadId, log, err => next(err, res));
                    }
                    return next(null, res);
                }),
            (err, data) => {
                if (err) {
                    // eslint-disable-next-line no-param-reassign
                    err.origin = 'source';
                    log.error('an error occurred on putting MPU part to S3', {
                        method:
                            'MultipleBackendTask._completeRangedMPU',
                        entry: sourceEntry.getLogInfo(),
                        origin: 'target',
                        peer: this.destBackbeatHost,
                        error: err.message,
                    });
                    return doneOnce(err);
                }
                return this._completeMPU(sourceEntry, uploadId, data,
                    log, doneOnce);
            });
    }

    /**
     * Wrapper for handling an ongoing MPU.
     * @param {ObjectQueueEntry} sourceEntry - The source object entry
     * @param {String} uploadId - The upload ID of the initiated MPU
     * @param {Werelogs} log - The logger instance
     * @param {Function} cb - The callback to call
     * @return {undefined}
     */
    _checkMPUState(sourceEntry, uploadId, log, cb) {
        return this._checkObjectState(sourceEntry, log, err => {
            if (err) {
                if (err && !err.InvalidObjectState) {
                    return cb(err);
                }
                // The latest object has different content so an attempt at CRR
                // will fail in CloudServer. We can safely skip this entry
                // because it is not the latest object.
                return this._multipleBackendAbortMPU(sourceEntry,
                    uploadId, log, () => cb(errors.InvalidObjectState));
            }
            return cb();
        });
    }

    _getAndPutMultipartUploadOnce(sourceEntry, log, cb) {
        const doneOnce = jsutil.once(cb);
        log.debug('replicating MPU data', { entry: sourceEntry.getLogInfo() });
        if (sourceEntry.getReplicationIsNFS()) {
            return this._checkObjectState(sourceEntry, log, err => {
                if (err) {
                    return doneOnce(err);
                }
                return this._sendInitiateMPU(sourceEntry, log, doneOnce);
            });
        }
        return this._sendInitiateMPU(sourceEntry, log, doneOnce);
    }

    /**
     * Send the initiate MPU request and then complete the MPU.
     * @param {ObjectQueueEntry} sourceEntry - The source object entry
     * @param {Werelogs} log - The logger instance
     * @param {Function} doneOnce - The callback to call
     * @return {undefined}
     */
    _sendInitiateMPU(sourceEntry, log, doneOnce) {
        return this._initiateMPU(sourceEntry, log, (err, uploadId) => {
            if (err) {
                return doneOnce(err);
            }
            const extMetrics = getExtMetrics(this.site,
                sourceEntry.getContentLength(), sourceEntry);
            this.mProducer.publishMetrics(extMetrics, metricsTypeQueued,
                metricsExtension, () => {});
            return this._completeRangedMPU(sourceEntry,
                uploadId, log, doneOnce);
        });
    }

    _getAndPutPart(sourceEntry, part, log, cb) {
        const partLogger = this.logger.newRequestLogger(log.getUids());
        this.retry({
            actionDesc: 'stream part data',
            logFields: { entry: sourceEntry.getLogInfo(), part },
            actionFunc: done => this._getAndPutPartOnce(
                sourceEntry, part, partLogger, done),
            shouldRetryFunc: err => err.retryable,
            onRetryFunc: err => {
                if (err.origin === 'target') {
                    this.destHosts.pickNextHost();
                    this._setupDestClients(this.targetRole, partLogger);
                }
            },
            log: partLogger,
        }, cb);
    }

    _getAndPutPartOnce(sourceEntry, part, log, done) {
        log.debug('getting object part', { entry: sourceEntry.getLogInfo() });
        const doneOnce = jsutil.once(done);
        const partObj = part ? new ObjectMDLocation(part) : undefined;
        const size = part ? partObj.getPartSize() :
            sourceEntry.getContentLength();
        let incomingMsg = null;
        if (size !== 0) {
            const sourceReq = this.backbeatSource.getObject({
                Bucket: sourceEntry.getBucket(),
                Key: sourceEntry.getObjectKey(),
                VersionId: sourceEntry.getEncodedVersionId(),
                PartNumber: part ? partObj.getPartNumber() : undefined,
                LocationConstraint: sourceEntry.getDataStoreName(),
            });
            attachReqUids(sourceReq, log);
            sourceReq.on('error', err => {
                // eslint-disable-next-line no-param-reassign
                err.origin = 'source';
                if (err.statusCode === 404) {
                    log.error('the source object was not found', {
                        method: 'MultipleBackendTask._getAndPutPartOnce',
                        entry: sourceEntry.getLogInfo(),
                        origin: 'source',
                        peer: this.sourceConfig.s3,
                        error: err.message,
                        httpStatus: err.statusCode,
                    });
                    return doneOnce(err);
                }
                log.error('an error occurred on getObject from S3', {
                    method: 'MultipleBackendTask._getAndPutPartOnce',
                    entry: sourceEntry.getLogInfo(),
                    origin: 'source',
                    peer: this.sourceConfig.s3,
                    error: err.message,
                    httpStatus: err.statusCode,
                });
                return doneOnce(err);
            });
            incomingMsg = sourceReq.createReadStream();
            incomingMsg.on('error', err => {
                if (err.statusCode === 404) {
                    log.error('the source object was not found', {
                        method: 'MultipleBackendTask._getAndPutPartOnce',
                        entry: sourceEntry.getLogInfo(),
                        origin: 'source',
                        peer: this.sourceConfig.s3,
                        error: err.message,
                        httpStatus: err.statusCode,
                    });
                    return doneOnce(errors.ObjNotFound);
                }
                // eslint-disable-next-line no-param-reassign
                err.origin = 'source';
                log.error('an error occurred when streaming data from S3', {
                    entry: sourceEntry.getLogInfo(),
                    method: 'MultipleBackendTask._getAndPutPartOnce',
                    origin: 'source',
                    peer: this.sourceConfig.s3,
                    error: err.message,
                });
                return doneOnce(err);
            });
            log.debug('putting data', { entry: sourceEntry.getLogInfo() });
        }
        if (sourceEntry.getReplicationIsNFS()) {
            return this._checkObjectState(sourceEntry, log, err => {
                if (err) {
                    return doneOnce(err);
                }
                return this._sendMultipleBackendPutObject(sourceEntry,
                    part, partObj, size, incomingMsg, log, doneOnce);
            });
        }
        return this._sendMultipleBackendPutObject(sourceEntry, part,
            partObj, size, incomingMsg, log, doneOnce);
    }

    /**
     * Get the source object metadata and ensure the latest object MD5 hash is
     * the same as the entry.
     * @param {ObjectQueueEntry} sourceEntry - The source object entry
     * @param {Werelogs} log - The logger instance
     * @param {Function} cb - The callback to call
     * @return {undefined}
     */
    _checkObjectState(sourceEntry, log, cb) {
        return this._fetchSourceMD(
        sourceEntry.getBucket(), sourceEntry.getObjectKey(),
            sourceEntry.getEncodedVersionId(), log, (err, objMD) => {
            if (err && err.code === 'ObjNotFound' &&
            !sourceEntry.getIsDeleteMarker()) {
                // The source object was unexpectedly deleted, so we skip CRR
                // here.
                return cb(errors.InvalidObjectState);
            }
            if (err) {
                return cb(err);
            }
            if (objMD.getContentMd5() !== sourceEntry.getContentMd5()) {
                // The latest object has different content so an attempt at CRR
                // will fail in CloudServer. We can safely skip this entry
                // because it is not the latest object.
                return cb(errors.InvalidObjectState);
            }
            return cb();
        });
    }

    /**
     * Send the put object request to Cloudserver.
     * @param {ObjectQueueEntry} sourceEntry - The source object entry
     * @param {Object} part - single data location info
     * @param {ObjectMDLocation} partObj - The instance to get a part location
     * @param {Number} size - The size of object to stream
     * @param {Readable} incomingMsg - The stream of data to put
     * @param {Werelogs} log - The logger instance
     * @param {Function} doneOnce - The callback to call
     * @return {undefined}
     */
    _sendMultipleBackendPutObject(sourceEntry, part, partObj, size,
        incomingMsg, log, doneOnce) {
        const destReq = this.backbeatSource.multipleBackendPutObject({
            Bucket: sourceEntry.getBucket(),
            Key: sourceEntry.getObjectKey(),
            CanonicalID: sourceEntry.getOwnerId(),
            ContentLength: size,
            ContentMD5: part ? partObj.getPartETag() :
                sourceEntry.getContentMd5(),
            StorageType: sourceEntry.getReplicationStorageType(),
            StorageClass: this.site,
            VersionId: sourceEntry.getEncodedVersionId(),
            UserMetaData: sourceEntry.getUserMetadata(),
            ContentType: sourceEntry.getContentType() || undefined,
            CacheControl: sourceEntry.getCacheControl() || undefined,
            ContentDisposition:
                sourceEntry.getContentDisposition() || undefined,
            ContentEncoding: sourceEntry.getContentEncoding() || undefined,
            Body: incomingMsg,
        });
        attachReqUids(destReq, log);
        return destReq.send((err, data) => {
            if (err) {
                // eslint-disable-next-line no-param-reassign
                err.origin = 'source';
                log.error('an error occurred on putData to S3', {
                    method: 'MultipleBackendTask._getAndPutPartOnce',
                    entry: sourceEntry.getLogInfo(),
                    origin: 'target',
                    peer: this.destBackbeatHost,
                    error: err.message,
                });
                return doneOnce(err);
            }
            sourceEntry.setReplicationSiteDataStoreVersionId(this.site,
                data.versionId);
            const extMetrics = getExtMetrics(this.site, size, sourceEntry);
            this.mProducer.publishMetrics(extMetrics,
                metricsTypeCompleted, metricsExtension, () => {});
            return doneOnce(null, data);
        });
    }

    _putObjectTagging(sourceEntry, log, cb) {
        this.retry({
            actionDesc: 'send object tagging XML data',
            entry: sourceEntry,
            logFields: { entry: sourceEntry.getLogInfo() },
            actionFunc: done => this._putObjectTaggingOnce(
                sourceEntry, log, done),
            shouldRetryFunc: err => err.retryable,
            log,
        }, cb);
    }

    _putObjectTaggingOnce(sourceEntry, log, cb) {
        const doneOnce = jsutil.once(cb);
        log.debug('replicating object tags', {
            entry: sourceEntry.getLogInfo(),
        });
        const destReq = this.backbeatSource
            .multipleBackendPutObjectTagging({
                Bucket: sourceEntry.getBucket(),
                Key: sourceEntry.getObjectKey(),
                StorageType: sourceEntry.getReplicationStorageType(),
                StorageClass: this.site,
                DataStoreVersionId:
                    sourceEntry.getReplicationSiteDataStoreVersionId(this.site),
                Tags: JSON.stringify(sourceEntry.getTags()),
                SourceBucket: sourceEntry.getBucket(),
                SourceVersionId: sourceEntry.getVersionId(),
                ReplicationEndpointSite: this.site,
            });
        attachReqUids(destReq, log);
        return destReq.send((err, data) => {
            if (err) {
                log.error('an error occurred putting object tagging to S3', {
                    method: 'MultipleBackendTask._putObjectTaggingOnce',
                    entry: sourceEntry.getLogInfo(),
                    origin: 'target',
                    error: err.message,
                });
                return doneOnce(err);
            }
            sourceEntry.setReplicationSiteDataStoreVersionId(this.site,
                data.versionId);
            return doneOnce();
        });
    }

    _deleteObjectTagging(sourceEntry, log, cb) {
        this.retry({
            actionDesc: 'delete object tagging',
            logFields: { entry: sourceEntry.getLogInfo() },
            actionFunc: done => this._deleteObjectTaggingOnce(sourceEntry,
                log, done),
            shouldRetryFunc: err => err.retryable,
            log,
        }, cb);
    }

    _deleteObjectTaggingOnce(sourceEntry, log, cb) {
        const doneOnce = jsutil.once(cb);
        log.debug('replicating delete object tagging', {
            entry: sourceEntry.getLogInfo(),
        });
        const destReq = this.backbeatSource.multipleBackendDeleteObjectTagging({
            Bucket: sourceEntry.getBucket(),
            Key: sourceEntry.getObjectKey(),
            StorageType: sourceEntry.getReplicationStorageType(),
            StorageClass: this.site,
            DataStoreVersionId:
                sourceEntry.getReplicationSiteDataStoreVersionId(this.site),
            SourceBucket: sourceEntry.getBucket(),
            SourceVersionId: sourceEntry.getVersionId(),
            ReplicationEndpointSite: this.site,
        });
        attachReqUids(destReq, log);
        return destReq.send((err, data) => {
            if (err) {
                log.error('an error occurred on deleting object tagging', {
                    method: 'MultipleBackendTask._deleteObjectTaggingOnce',
                    entry: sourceEntry.getLogInfo(),
                    origin: 'target',
                    peer: this.destBackbeatHost,
                    error: err.message,
                });
                return doneOnce(err);
            }
            sourceEntry.setReplicationSiteDataStoreVersionId(this.site,
                data.versionId);
            return doneOnce();
        });
    }

    _getAndPutData(sourceEntry, log, cb) {
        // FIXME this function seems to duplicate
        // ReplicateObject._getAndPutData(), consider merging implementations
        log.debug('replicating data', { entry: sourceEntry.getLogInfo() });
        if (sourceEntry.getLocation().some(part => {
            const partObj = new ObjectMDLocation(part);
            return partObj.getDataStoreETag() === undefined;
        })) {
            const errMessage =
                  'cannot replicate object without dataStoreETag property';
            log.error(errMessage, {
                method: 'MultipleBackendTask._getAndPutData',
                entry: sourceEntry.getLogInfo(),
            });
            return cb(errors.InternalError.customizeDescription(errMessage));
        }
        const locations = sourceEntry.getReducedLocations();
        // Metadata-only operations have no part locations.
        if (locations.length === 0) {
            return this._getAndPutPart(sourceEntry, null, log, cb);
        }
        const extMetrics = getExtMetrics(this.site,
            sourceEntry.getContentLength(), sourceEntry);
        this.mProducer.publishMetrics(extMetrics,
            metricsTypeQueued, metricsExtension, () => {});
        return async.mapLimit(locations, MPU_CONC_LIMIT, (part, done) =>
            this._getAndPutPart(sourceEntry, part, log, done), cb);
    }

    _putDeleteMarker(sourceEntry, log, cb) {
        this.retry({
            actionDesc: 'put delete marker',
            logFields: { entry: sourceEntry.getLogInfo() },
            actionFunc: done => this._putDeleteMarkerOnce(
                sourceEntry, log, done),
            shouldRetryFunc: err => err.retryable,
            log,
        }, cb);
    }

    _putDeleteMarkerOnce(sourceEntry, log, cb) {
        const doneOnce = jsutil.once(cb);
        log.debug('replicating delete marker', {
            entry: sourceEntry.getLogInfo(),
        });
        if (sourceEntry.getReplicationIsNFS()) {
            return this._checkObjectState(sourceEntry, log, err => {
                if (err && err.code !== 'ObjNotFound') {
                    // If it is a non-versioned object, the object will not be
                    // found. However we still want to replicate a delete
                    // marker.
                    return doneOnce(err);
                }
                return this._sendMultipleBackendDeleteObject(sourceEntry, log,
                    doneOnce);
            });
        }
        return this._sendMultipleBackendDeleteObject(sourceEntry, log,
            doneOnce);
    }

    /**
     * Send a delete object request to the source.
     * @param {ObjectQueueEntry} sourceEntry - The object entry
     * @param {Werelogs} log - The logger instance
     * @param {Function} doneOnce - The callback to call
     * @return {undefined}
     */
    _sendMultipleBackendDeleteObject(sourceEntry, log, doneOnce) {
        const destReq = this.backbeatSource.multipleBackendDeleteObject({
            Bucket: sourceEntry.getBucket(),
            Key: sourceEntry.getObjectKey(),
            StorageType: sourceEntry.getReplicationStorageType(),
            StorageClass: this.site,
        });
        attachReqUids(destReq, log);
        return destReq.send(err => {
            if (err) {
                // eslint-disable-next-line no-param-reassign
                err.origin = 'source';
                log.error('an error occurred on putting delete marker to S3', {
                    method: 'MultipleBackendTask._putDeleteMarkerOnce',
                    entry: sourceEntry.getLogInfo(),
                    origin: 'target',
                    peer: this.destBackbeatHost,
                    error: err.message,
                });
                return doneOnce(err);
            }
            return doneOnce();
        });
    }

    processQueueEntry(sourceEntry, kafkaEntry, done) {
        const log = this.logger.newRequestLogger();
        if (sourceEntry instanceof ActionQueueEntry) {
            if (sourceEntry.getActionType() === 'copyData') {
                return this._processCopyDataAction(
                    sourceEntry, kafkaEntry, log, done);
            }
            return done(errors.InternalError);
        }
        return this._processReplicationEntry(
            sourceEntry, kafkaEntry, log, done);
    }

    _processReplicationEntry(sourceEntry, kafkaEntry, log, done) {
        log.debug('processing replication entry', {
            entry: sourceEntry.getLogInfo(),
        });

        this._setupSourceClients(null, log);
        const content = sourceEntry.getReplicationContent();
        return async.waterfall([
            next => this._getBucketReplicationConfiguration(
                sourceEntry, log, next),
            next => this._fetchSourceMD(sourceEntry, log, (err, res) => {
                if (err && err.code === 'ObjNotFound' &&
                    sourceEntry.getReplicationIsNFS() &&
                    !sourceEntry.getIsDeleteMarker()) {
                    // The object was deleted before entry is processed, we
                    // can safely skip this entry.
                    return next(errors.InvalidObjectState);
                }
                if (err) {
                    return next(err);
                }
                return next(null, res);
            }),
            (sourceMD, next) => {
                if (sourceEntry.getIsDeleteMarker()) {
                    return this._putDeleteMarker(sourceEntry, log, next);
                }
                const status = sourceMD.getReplicationSiteStatus(
                    this.site);
                log.debug('refreshed entry site replication info', {
                    entry: sourceEntry.getLogInfo(),
                    site: this.site, siteStatus: status,
                    content,
                });
                if (status === 'COMPLETED' && content.includes('DATA')) {
                    const errMessage = 'skipping replication: ' +
                          'replication status is already COMPLETED ' +
                          `on the location ${this.site}`;
                    log.warn(errMessage, {
                        entry: sourceEntry.getLogInfo(),
                    });
                    return next(errors.InvalidObjectState.customizeDescription(
                        errMessage));
                }
                if (content.includes('MPU')) {
                    return this._getAndPutMultipartUpload(sourceEntry,
                        log, next);
                }
                if (content.includes('PUT_TAGGING')) {
                    return this._putObjectTagging(sourceEntry, log, next);
                }
                if (content.includes('DELETE_TAGGING')) {
                    return this._deleteObjectTagging(sourceEntry, log, next);
                }
                return this._getAndPutData(sourceEntry, log, next);
            },
        ], err => this._handleReplicationOutcome(
            err, sourceEntry, kafkaEntry, log, done));
    }

    _handleReplicationOutcome(err, sourceEntry, kafkaEntry, log, done) {
        if (!err) {
            log.debug('replication succeeded for object, publishing ' +
                      'replication status as COMPLETED',
                      { entry: sourceEntry.getLogInfo() });
            this._publishReplicationStatus(
                sourceEntry, 'COMPLETED', { kafkaEntry, log });
            return done(null, { committable: false });
        }
        if (err.BadRole ||
            (err.origin === 'source' &&
             (err.NoSuchEntity || err.code === 'NoSuchEntity' ||
              err.AccessDenied || err.code === 'AccessDenied'))) {
            log.error('replication failed permanently for object, ' +
                      'processing skipped',
                { failMethod: err.method,
                    entry: sourceEntry.getLogInfo(),
                    origin: err.origin,
                    error: err.description });
            return done();
        }
        if (err.ObjNotFound || err.code === 'ObjNotFound') {
            log.info('replication skipped: ' +
                     'source object version does not exist',
                     { entry: sourceEntry.getLogInfo() });
            return done();
        }
        if (err.InvalidObjectState || err.code === 'InvalidObjectState') {
            log.info('replication skipped: invalid object state',
                     { entry: sourceEntry.getLogInfo() });
            return done();
        }
        log.debug('replication failed permanently for object, ' +
                  'publishing replication status as FAILED',
            { failMethod: err.method,
                entry: sourceEntry.getLogInfo(),
                error: err.description });
        this._publishReplicationStatus(
            sourceEntry, 'FAILED', {
                log,
                reason: err.description,
                kafkaEntry,
            });
        return done(null, { committable: false });
    }

    _processCopyDataAction(sourceEntry, kafkaEntry, log, done) {
        log.debug('processing copyData action entry', {
            entry: sourceEntry.getLogInfo(),
        });

        this._setupSourceClients(null, log);
        return done();
    }
}

module.exports = MultipleBackendTask;
