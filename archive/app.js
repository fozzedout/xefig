var CoinbaseExchange = require('coinbase-exchange');
var publicClient = new CoinbaseExchange.PublicClient();
var cryptoCurrency = "BTC";
var fiatCurrency = "USD";
publicClient.productID = cryptoCurrency + "-" + fiatCurrency;

var authedClient = new CoinbaseExchange.AuthenticatedClient(
    "9d554314eed1d14230dedd11b2aa0f8f", 
    "8hkeCEN9HDcCGNCSmgfZQEjhxJLImgqSwIzMbJuAWanKCO8YCSgT+ltxkS/XawaGwxzfzZfDRykAlxokb8T/ow==", 
    "tb8sejs0irs8m2t9");

var sequenceID = 0;
var price  = 0.0;

var output = "";
function outputLog(value) {
    console.log(value);
    output += value + "\r\n";
}

var lastPrice = 0.0;
fs = require("fs");
if (fs.existsSync("lastPrice.txt")) {
    lastPrice = parseFloat( fs.readFileSync("lastPrice.txt", 'utf8') );
}
outputLog("Last price: " + lastPrice);

var minPercentToTake = 0.1;
fs = require("fs");
if (fs.existsSync("~$minPercentToTake.txt")) {
    minPercentToTake = parseFloat( fs.readFileSync("~$minPercentToTake.txt", 'utf8') );
}
outputLog("Last price: " + minPercentToTake);

var walletCrypto = 0.0;
var walletCash = 0.0;

var spread = 0.0;
var ask = 0.0;
var bid = 0.0;
var mid = 0.0;
var slope = 0.0;
var buyOrSell ="";
var delayBeforeNextTransaction = 100;

var priceFeed1min = [];
var priceFeed5min = [];

var clock = {
    now: Date.now(),
    add: function (qty, units) {
        switch (units.toLowerCase()) {
            case 'w': val = qty * 1000 * 60 * 60 * 24 * 7; break;
            case 'd': val = qty * 1000 * 60 * 60 * 24; break;
            case 'h': val = qty * 1000 * 60 * 60; break;
            case 'm': val = qty * 1000 * 60; break;
            case 's': val = qty * 1000; break;
            default       : val = undefined; break;
        }
        return val;
    },
    format: function (timestamp) {
        var date = new Date(timestamp);
        var year = date.getFullYear();
        var month = "0" + (date.getMonth() + 1);
        var day = "0" + date.getDate();
        var hours = "0" + date.getHours();
        var minutes = "0" + date.getMinutes();
        var seconds = "0" + date.getSeconds();
        
        return formattedTime = year + '/' + 
                               month.substr(-2) + '/' + 
                               day.substr(-2) + ' ' + 
                               hours.substr(-2) + ':' + 
                               minutes.substr(-2) + ':' + 
                               seconds.substr(-2);
    }
};

var callback = function (err, response, data) {
	outputLog(data);
};

var ProductTickerCallback = function (err, response, data) {
    
    //outputLog(data);
    try {
		// if (data.sequence < sequenceID)
		// 	return;
		
		// sequenceID = data.sequence
		// bid = parseFloat(data.bids[0][0]);
		// ask = parseFloat(data.asks[0][0]);
        ask = parseFloat(data.ask);
        bid = parseFloat(data.bid);
		spread = ask - bid;
        mid = bid + (Math.floor((spread / 2.0) * 100) / 100);
        
        // if (walletCrypto > 0.0001)
    	// 	price = bid; //+ (Math.floor((spread / 2.0) * 100) / 100);
        // else
        //     price = ask;
        price = parseFloat(data.price);

        if (lastPrice == 0)
        {
            lastPrice = price;
            fs.writeFileSync("lastPrice.txt", lastPrice);
        }
    }
    catch (err) {
        return;
    }
    
	//outputLog("");
	//outputLog("[" + clock.format(Date.now()) + "]");
    
    if (priceFeed1min.length == 60) {
        priceFeed1min.shift();
    }
    priceFeed1min[priceFeed1min.length] = price;

    if (priceFeed5min.length == 3600 * 5) {
        priceFeed5min.shift();
    }
    priceFeed5min[priceFeed5min.length] = price;
    
    // spread too large for profit, ignore
    // if (spread > 0.20)
    //     return;

    // 1 min feed check:  once get to 60 items in the array, calculate slope, and buy/sell/abstain according to slope
    buyOrSell ="";
    slope = CalcSlope(priceFeed1min, 30);

    output

    if (priceFeed1min.length >= 30) {
            output = "";
            outputLog("");
            outputLog("[" + clock.format(Date.now()) + "]  Bid: " + bid.toFixed(2) + "  Ask:" + ask.toFixed(2) + "     Curr Price:" + price.toFixed(2) + "   Last Price:" + lastPrice.toFixed(2) + "     wallet: " + cryptoCurrency + ": " + walletCrypto.toFixed(8) + "  " + fiatCurrency + ": " + walletCash);
            outputLog("  1 min Slope: " + (slope >= 0 ? " " : "") + slope.toFixed(5) + "   slope check: b 1     s -0.3     spread: " + spread.toFixed(2) + "     minPercentToTake: " + minPercentToTake.toFixed(7) );
            outputLog("  prev price: " + priceFeed1min[priceFeed1min.length-2].toFixed(2) + "     buy/ask < " + (lastPrice - ((lastPrice * minPercentToTake)+spread) ).toFixed(2) + "    curr price: " + price.toFixed(2) + "     sell/bid > " + (lastPrice + ((lastPrice * minPercentToTake)+spread) ).toFixed(2) );

        if (walletCash > 10)
        {
            if ( ( slope > 1) ) {
                outputLog("   Buy " + cryptoCurrency + " / sell cash");
                buyOrSell = "buy";
    
                // buy, so reset the minPercentToTake to 10%
                minPercentToTake = 0.1;
                fs.writeFileSync("~$minPercentToTake.txt", minPercentToTake);
            }
        }
        if (walletCrypto >= 0.001)
        {
            minPercentToTake -= 0.0000001;
            fs.writeFileSync("~$minPercentToTake.txt", minPercentToTake);

            // sell when the minPercentToTake is in range (starting at 10% and v. slowly going down)
            if (ask - lastPrice > (lastPrice * minPercentToTake) + spread ) {
                outputLog("   Sell " + cryptoCurrency + " / buy cash");
                buyOrSell = "sell";
            }

            // if close to the break even limit when the price is going down, then sell immediately
            if ( buyOrSell == "" && slope < -0.3 )
            {
                if ((ask - lastPrice > (lastPrice * 0.035) + spread ) && (ask - lastPrice < (lastPrice * 0.55) + spread ) ) {
                    outputLog("   Sell " + cryptoCurrency + " / buy cash");
                    buyOrSell = "sell";
                }
            }
        }
    }
    
    if (buyOrSell == "buy") {
		buyCrypto();
    }
    else if (buyOrSell == "sell") {
		sellCrypto();
    }

    
    // if (!fs.existsSync("D:\\temp\\marketlog.csv"))
    //    fs.appendFileSync("D:\\temp\\marketlog.csv", "timestamp,bid,ask,midprice,slope,spread,buyOrSell,walletCrypto,walletCash,data.price\r\n");
    // fs.appendFileSync("D:\\temp\\marketlog.csv", clock.format(Date.now()) + "," + data.bid + "," + data.ask + "," + price + "," + slope + "," + spread + "," + buyOrSell + "," + walletCrypto + "," + walletCash + "," + data.price + "\r\n");

    //authedClient.getAccounts(GetAccountsCallback);
};

function buyCrypto() {
    if (walletCash > 15) {
        var params = {
            'price': bid, // cash price per cryptocoin
            'size': Math.floor(((walletCash * 0.999) / bid) * 1000) / 1000,  // Crypto
            'product_id': cryptoCurrency + '-' + fiatCurrency,
            'type': 'market',
           //'time_in_force' : 'IOC',
            'side' : 'buy'
        };
        authedClient.buy(params, callback);
        outputLog("     " + params.size + " " + cryptoCurrency + " Bought");

        //priceFeed1min = [];
        //priceFeed5min = [];

        //setTimeout(function () { authedClient.getAccounts(GetAccountsCallback) }, 1000);
		// var walletCashToCrypto = (Math.floor(((walletCash * 0.999) / ask) * 1000) / 1000);
		lastPrice = bid; // + (ask * walletCashToCrypto * 0.025);
        fs.writeFileSync("lastPrice.txt", lastPrice);
        
		walletCash = 0;
        authedClient.getAccounts(GetAccountsCallback);
        return true;
    }
    return false;
}
function sellCrypto() {
    if (walletCrypto >= 0.001) {
        var params = {
            'price': ask, // price per bitcoin
            'size': Math.floor(walletCrypto * 1000000) / 1000000, // all my Crypto funds (rounded to 7 decimal places)
            'product_id': cryptoCurrency + '-' + fiatCurrency,
            'type': 'market',
        	//'time_in_force' : 'IOC',
            'side': 'sell'
        };
        authedClient.sell(params, callback);
        outputLog("     " + params.size + " " + cryptoCurrency + " Sold");
        
        //priceFeed1min = [];
        //priceFeed5min = [];
		lastPrice = ask; //- (bid * walletCrypto * 0.025);
        fs.writeFileSync("lastPrice.txt", lastPrice);

		walletCrypto = 0;
        authedClient.getAccounts(GetAccountsCallback);
        return true;
    }
    return false;

}

function normalisedPrice()
{
    if (walletCash > 100)
    {
        return walletCash;
    }
    else
    {
        return walletCrypto / price;
    }
}

function CalcSlope(priceFeed, dataPointLength) {
    if (dataPointLength > 0 && priceFeed.length < dataPointLength)
		return 0;
	
	if (dataPointLength > 0) {
		datapoints = priceFeed.slice(-dataPointLength);
	} else {
		datapoints = priceFeed;
		dataPointLength = datapoints.length;
	}
	
	// let n = the number of datapoints
    var n = dataPointLength;

    // let a = n times the summation of values multiplied by their coreresponding index values plus 1
    var a = 0.0;
    for (var i = 0; i < n; i++) {
        a = a + ((i + 1) * datapoints[i]);
    }
    a = n * a;

    // let b = the sum of all values times the sum of all values times the sum of all coreresponding index values plus 1
    var b = 0.0;
    for (var i = 0; i < n; i++) {
        b = b + datapoints[i];
    }
    b = ((n * (n + 1)) / 2) * b;

    // let c = n times the sum of all squared all coreresponding index values plus 1
    var c = 0.0;
    for (var i = 1; i <= n; i++) {
        c = c + Math.pow(i,2);
    }
    c = n * c;

    // let d = the squared sum of all coreresponding index values plus 1
    var d = Math.pow(((n * (n + 1)) / 2), 2);

    var slope = (a - b) / (c - d);

    return slope;
};



var GetAccountsCallback = function (err, response, data) {
    //outputLog("GetAccountsCallback");
    //outputLog(data);
    if (data == null)
        return;

    var updated = false;
    for (var i = 0; i < data.length; i++) {
        if (data[i].currency == cryptoCurrency)
        {
            var value = parseFloat(data[i].available); //Math.floor(parseFloat(data[i].balance) * 100) / 100;
            if (walletCrypto != value) {
                walletCrypto = value;
                updated = true;
            }
        }
        else if (data[i].currency == fiatCurrency)
        {
            var value = Math.floor(parseFloat(data[i].available) * 100) / 100;
            if (walletCash != value) {
                walletCash = value;
                updated = true;
            }
        }
    }
    if (updated) {
        outputLog("                                                                         wallet" + cryptoCurrency + " : " + walletCrypto.toFixed(7));
        outputLog("                                                                         wallet" + fiatCurrency + " : " + walletCash);
    }
};

outputLog('call ProductTicker');
publicClient.getProductTicker(ProductTickerCallback)
outputLog("authedClient.getAccounts(callback);");
authedClient.getAccounts(GetAccountsCallback);

setInterval(
    function () {
        //outputLog('call ProductTicker');
        publicClient.getProductTicker(ProductTickerCallback);
        //publicClient.getProductOrderBook(ProductTickerCallback)

        if (!fs.existsSync("D:\\temp\\priceWatchFull.csv"))
            fs.appendFileSync("D:\\temp\\priceWatchFull.csv", "timestamp,price,slope,slope30sec,slope1min,slope2min,slope3min,slope5min,slope10min,slope15min,slope30min,slope1hr,slope2hr,slope3hr,slope4hr,slope5hr\r\n");

		slope30sec = CalcSlope(priceFeed5min, 30);
		slope1min = CalcSlope(priceFeed5min, 60);
		slope2min = CalcSlope(priceFeed5min, 60 * 2);
		slope3min = CalcSlope(priceFeed5min, 60 * 3);
		slope5min = CalcSlope(priceFeed5min, 60 * 5);
		slope10min = CalcSlope(priceFeed5min, 60 * 10);
		slope15min = CalcSlope(priceFeed5min, 60 * 15);
		slope30min = CalcSlope(priceFeed5min, 60 * 30);
		slope1hr = CalcSlope(priceFeed5min, 3600);
		slope2hr = CalcSlope(priceFeed5min, 3600 * 2);
		slope3hr = CalcSlope(priceFeed5min, 3600 * 3);
		slope4hr = CalcSlope(priceFeed5min, 3600 * 4);
		slope5hr = CalcSlope(priceFeed5min, 0);

        fs.appendFileSync("D:\\temp\\priceWatchFull.csv", 
		clock.format(Date.now()) + "," + 
		price + "," + 
		slope + "," + 
		slope30sec + "," + 
		slope1min + "," + 
		slope2min + "," + 
		slope3min + "," + 
		slope5min + "," + 
		slope10min + "," + 
		slope15min + "," + 
		slope30min + "," + 
		slope1hr + "," + 
		slope2hr + "," + 
		slope3hr + "," + 
		slope4hr + "," + 
		slope5hr + "\r\n");
    }, 
    1000);

setInterval(
    function () {
        //outputLog("authedClient.getAccounts(callback);");
        authedClient.getAccounts(GetAccountsCallback);
    }, 
    30000)

setInterval(
    function () {
        if (!fs.existsSync("D:\\temp\\priceWatch.csv"))
            fs.appendFileSync("D:\\temp\\priceWatch.csv", "timestamp,price,slope,spread,buyOrSell,walletCrypto,walletCash,normalisedWallet\r\n");
        fs.appendFileSync("D:\\temp\\priceWatch.csv", clock.format(Date.now()) + "," + price + "," + slope + "," + spread + "," + buyOrSell + "," + walletCrypto + "," + walletCash + "," + normalisedPrice() + "\r\n");
         
    }, 
    3600000 // 1 hour = 3600 seconds * 1000 milliseonds
)

var express = require('express');
var app = express();
app.get('/', function(req, res) {
    var html = "";
    html += "<html><head><meta http-equiv='refresh' content='5'><script src='https://cdn.jsdelivr.net/npm/vue/dist/vue.js'></script></head><body><div id='app'><p>{{ message }}</p></div><pre>" + output + "</pre></body></html>";
    res.send(html);
});
var server = app.listen(80, function() {

});