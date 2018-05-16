'use strict';

var async = require('async');
var _ = require('lodash');
var BigNumber = require('bignumber.js');
var Common = require('./common');
var util = require('util');
var EventEmitter = require('events').EventEmitter;

function StatisticsController(options) {

	this.node = options.node;
	this.addressBalanceService = options.addressBalanceService;
	this.addressBlocksMinedRepository = options.addressBlocksMinedRepository;

    /**
     *
     * @type {Common}
     */
	this.common = new Common({log: this.node.log});

}

util.inherits(StatisticsController, EventEmitter);

StatisticsController.prototype.getRichestAddressesList = function (req, res) {

    var self = this,
        dataFlow = {
            addressesList: [],
            addressesMinedMap: {}
        };

    return async.waterfall([function (callback) {
        return self.addressBalanceService.getRichestAddressesList(function (err, items) {

            if (err) {
                return callback(err);
            }

            dataFlow.addressesList = items;

            return callback();

        });
    }, function (callback) {
        if (!dataFlow.addressesList.length) {
            return callback();
        }

        return self.addressBlocksMinedRepository.getMinedBlocksByAddresses(dataFlow.addressesList.map(function (item) {
            return item.address;
        }), function (err, addressesMined) {

            if (err) {
                return callback(err);
            }

            dataFlow.addressesMinedMap = _.reduce(addressesMined, function(addressesMinedMap, item) {
                    addressesMinedMap[item.address] = item.count;
                    return addressesMinedMap;
                } , {});

            return callback();
        })
    }], function (err) {

        if (err) {
            return self.common.handleErrors(err, res);
        }
        
        return res.jsonp(dataFlow.addressesList.map(function (item) {
            return {
                address: item.address,
                blocks_mined: dataFlow.addressesMinedMap[item.address] ? dataFlow.addressesMinedMap[item.address] : 0,
                balance: item.balance
            }
        }));
    });



};


module.exports = StatisticsController;