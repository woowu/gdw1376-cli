#!/usr/bin/env -S node --harmony

import { parseArgs } from 'node:util';
import net from 'node:net';
import fs from 'node:fs';
import { hexy } from 'hexy';

const AFN_READ_HIST = 13;
const LEN_SZ = 2;
const FR_SYNC = 0x68;
const FR_END = 0x16;
const DATA_PREFIX_LEN = 19;

function delay(msec)
{
    return new Promise(resolv => {
        setTimeout(() => {
            resolv();
        }, msec);
    });
}

function parserInit(parser)
{
    parser.state = parserSyncOnChar;
}

function parserReset(parser)
{
    parser.state = parserSyncOnChar;
}

function parserOnChar(parser, c)
{
    parser.state(parser, c);
}

function parserSyncOnChar(parser, c)
{
    if (c == FR_SYNC) {
        parser.state = parserLen1OnChar;
        parser.tmp = [];
    }
}

function parserLen1OnChar(parser, c)
{
    parser.tmp.push(c);
    if (parser.tmp.length == 2) {
        parser.payloadLen = (parser.tmp[1] * 256 + parser.tmp[0]) >> 2;
        parser.state = parserLen2OnChar;
        parser.tmp = [];
    }
}

function parserLen2OnChar(parser, c)
{
    parser.tmp.push(c);
    if (parser.tmp.length == 2) {
        parser.state = parserSync2OnChar;
    }
}

function parserSync2OnChar(parser, c)
{
    if (c == FR_SYNC) {
        parser.state = parserPayloadOnChar;
        parser.sum = 0;
    } else
        parserRset(parser);
}

function parserPayloadOnChar(parser, c)
{
    parser.sum += c;
    parser.payload.push(c);
    if (parser.payload.length == parser.payloadLen)
        parser.state = parserChksumOnChar;
}

function parserChksumOnChar(parser, c)
{
    parser.receivedChksum = c;
    parser.state = parserEndOnChar;
}

function parserEndOnChar(parser, c)
{
    if (c != FR_END) {
        parserReset(parser);
        return;
    }
    if (parser.receivedChksum != parser.sum % 256) {
        console.error('Chksum mismatched');
        parserReset(parser);
    } else {
        console.log('Received a packet');
        onLinkData(parser.payload);
    }
}

/**
 * @n param 0 << n << 99
 */
function intToBcd(n)
{
    return (parseInt(n/10) << 4) | (n % 10);
}

function onLinkData(data)
{
    var x;

    if (! dataSink) return;

    data = data.slice(DATA_PREFIX_LEN);
    //console.log(hexy(data));
    while (data.length) {
        x = data.slice(0, 5);
        for (var i = 0; i < x.length; ++i) {
            dataSink.write(('0' + x[i].toString(16)).substr(-2));
        }
        dataSink.write('\n');
        data = data.slice(5);
    }
}

function mkReadHistReq(seq, afn, pn, fn, year, mon, day, h, m, T, nPeriods)
{
    const CTRL = 0x4b;
    const TERM_ADDR = [0x01, 0x00, 0x02, 0x00, 0x04];
    const frame = [];
    var len;
    var sum;

    frame.push(FR_SYNC);
    for (var i = 0; i < 2 * LEN_SZ; ++i)
        frame.push(0);
    frame.push(FR_SYNC);

    frame.push(CTRL);
    frame.push(...TERM_ADDR);
    frame.push(afn);
    frame.push(seq);
    // PN: DA encoding
    frame.push(1 << ((pn - 1) % 8));
    frame.push(parseInt((pn - 1)/8) + 1);
    // FN: DT encoding
    frame.push(1 << ((fn - 1) % 8));
    frame.push(parseInt((fn - 1)/8));
    // yy/mm/dd/hh/mm
    frame.push(intToBcd(m % 100));
    frame.push(intToBcd(h % 100));
    frame.push(intToBcd(day % 100));
    frame.push(intToBcd(mon % 100));
    frame.push(intToBcd(year % 100));
    frame.push(T);
    frame.push(nPeriods % 256);

    len = frame.length - 2 - 2 * LEN_SZ;
    frame[1] = ((len << 2) % 256) | 0x02;
    frame[2] = ((len << 2) >> 8) % 256;
    frame[3] = frame[1];
    frame[4] = frame[2];

    sum = 0;
    for (var i = 6; i < frame.length; ++i) sum += frame[i];
    frame.push(sum % 256);
    frame.push(FR_END);
    return Buffer.from(frame);
}

const options = {
    server: {
        type: 'string',
        short: 's',
    },
    port: {
        type: 'string',
        short: 'p',
    },
    pn: {
        type: 'string',
        short: 'A',
    },
    fn: {
        type: 'string',
        short: 'T',
    },
    period: {
        type: 'string',
        short: 'P',
    },
    periods: {
        type: 'string',
        short: 'n',
    },
    time: {
        type: 'string',
        short: 't',
    },
    output: {
        type: 'string',
        short: 'o',
    }
};

var dataSink;
var fn;
var pn;
var period;
var periods;
const reqTime = {
    year: 0,
    mon: 0,
    day: 0,
    hr: 0,
    m: 0,
};

const { values, positionals } = parseArgs(
    { options, allowPositionals: true }
);
if (! values.server) {
    console.error("No server address provided");
    process.exit();
}
if (! values.port || parseInt(values.port) <= 0) {
    console.error("No valid TCP port number provided");
    process.exit();
}
if (values.output)
    dataSink = fs.createWriteStream(values.output, { flags: 'a' });
if (values.fn) 
    fn = parseInt(values.fn);
else {
    console.error('No fn provided');
    process.exit(1);
}
if (values.pn)
    pn = parseInt(values.pn);
else {
    console.error('No pn provided');
    process.exit(1);
}
if (values.period)
    period = parseInt(values.period);
else {
    console.error('No period provided');
    process.exit(1);
}
if (values.periods)
    periods = parseInt(values.periods);
else {
    console.error('No periods provided');
    process.exit(1);
}
if (values.time) {
    // yy,MM,dd,hh,mm
    const tokens = values.time.split(',');
    if (tokens.length != 5) {
        console.error('Bad time format. Expect: yy,mm,dd,hh,mmm');
        process.exit(1);
    }
    reqTime.year = parseInt(tokens[0]);
    reqTime.mon = parseInt(tokens[1]);
    reqTime.day = parseInt(tokens[2]);
    reqTime.hr = parseInt(tokens[3]);
    reqTime.min = parseInt(tokens[4]);
} else {
    console.error('No request time provided');
    process.exit(1);
}

function requstHistData(cnt)
{
    var last_packet_time = 0;
    const parser = {
        state: null,
        payload: [],
        payloadLen: 0,
        tmp: [],
        sum: 0,
        receivedChksum: 0,
    };
    const client = new net.Socket();
    var seqno = 0;

    return new Promise(resolv => {
        parserInit(parser);

        console.log(`[${cnt}] Connecting ${values.server}:${values.port}`);
        client.connect({ port: parseInt(values.port), host: values.server },
            () => {
                const frame = mkReadHistReq(++seqno, AFN_READ_HIST
                    , pn, fn
                    , reqTime.year, reqTime.mon, reqTime.day
                    , reqTime.hr, reqTime.min
                    , period, periods);
                client.end(frame);
            }
        );
        client.on('data', (data) => {
            for (const c of data) {
                parserOnChar(parser, c);
            }
        });
        client.on('end', () => {
            console.log(`[${cnt}] Connection closed`);
            client.end();
            resolv();
        });
    });
}

var cnt = 0;
var startTime = Date.now();
while (true) {
    await requstHistData(++cnt);
    console.log(`Average speed ${1000*cnt/(Date.now() - startTime)} `
        + `requests per second`);
}
