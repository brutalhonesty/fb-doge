var FB = require('fb');
var crypto = require('crypto');
var bitcoin = require('bitcoin');
var dogeChainAPI = require('dogechain.js');
var redis = require('./redis.js');
var settings = require('./settings.js');
var client = new bitcoin.Client({
    host: settings.dogecoin.rpc.host,
    port: settings.dogecoin.rpc.port,
    user: settings.dogecoin.rpc.user,
    pass: settings.dogecoin.rpc.password
});
var clientID = settings.facebook.clientID;
var clientSecret = settings.facebook.clientSecret;
var accessToken = settings.facebook.accessToken;
var pageAccessToken = '';

// Parses the registration method to look for the doge address
// This method is expected to be called after getMessageType() verifies that we have a registration message
var parseRegisterMessage = function(message, callback) {
    var messageArray = message.split(' ');
    var dogeAddr = messageArray[1];
    if(dogeAddr === undefined || dogeAddr.length === 0) {
        return callback('Missing wallet address.');
    }
    return callback(null, dogeAddr);
};

// Hashes an unencrypted message with sha256 algorithm
var sha256Hash = function(unencrypted) {
    var hash = crypto.createHash('sha256').update(unencrypted).digest('hex');
    return hash;
};

// Old parsing method used for extracting amount and currency
// This is still in the code because of the commented code at the bottom of the page
// It has not been updated since this project started.
var parseTipMessage = function(message, callback) {
    var messageArray = message.split(' ');
    var tipData = {
        tipAmount: messageArray[3],
        tipCurrency: messageArray[4]
    };
    return callback(null, tipData);
};

// Parses a message to extract the coin and amount out
// Currently being used for withdraw
var parseCoin = function (coinStr, callback) {
    var coinStrArray = coinStr.split(' ');
    // Filter for empty
    coinStrArray = coinStrArray.filter(function (n) {
        if(n && n !== '' && n !== 'null' && n !== 'undefined' && n !== 'NaN') {
            return n;
        }
    });
    // We are expecting <command> <amount> <currency>
    if(coinStrArray.length < 2) {
        return callback('Missing amount and currency type.');
    }
    var coinAmount = 0;
    var coinName = null;
    for(var coinCounter = 0; coinCounter < coinStrArray.length; coinCounter++) {
        // We want something that is not a number (String) and that is not the word withdraw
        if(isNaN(parseFloat(coinStrArray[coinCounter])) && coinStrArray[coinCounter] !== 'withdraw') {
            isvalidCoinCode(coinStrArray[coinCounter], function (value) {
                if(value) {
                    coinName = coinStrArray[coinCounter].toUpperCase();
                }
            });
        // We want something that is a number
        } else if(!isNaN(parseFloat(coinStrArray[coinCounter]))) {
            coinAmount = parseFloat(coinStrArray[coinCounter]);
        }
    }
    if(coinAmount === 0 || !coinName) {
        return callback('Invalid currency type or amount, please try again.');
    }
    var coinData = {
        coinName: coinName,
        coinAmount: coinAmount
    };
    return callback(null, coinData);
};

// Check to see if the name of the coin that the bot can use is valid
// Currently testing with DOGE only
// http://en.wikipedia.org/wiki/List_of_cryptocurrencies
var isvalidCoinCode = function(coinStr, callback) {
    switch(coinStr.toUpperCase()) {
        case 'BTC':
        case 'LTC':
        case 'DOGE':
            return callback(true);
        default:
            return callback(false);
    }
};

// Verifies that the dogecoin address is legitimate
// Checks the known schema (34 length and starts with a D)
// Queries dogechain.info to verify address as well
var verifyAddr = function(dogeAddr, callback) {
    var errorMessage = 'Invalid doge address.';
    if(dogeAddr.length !== 34 || dogeAddr[0] !== 'D') {
        return callback(errorMessage);
    }
    dogeChainAPI.checkaddress(dogeAddr, function (error, response) {
        if(error) return callback(error);
        switch(response) {
            case 'X5':
            case 'SZ':
            case 'CK':
            return callback(errorMessage);
            default:
            return callback();
        }
    });
};

// Messages a user based on the messageID of the original message
// Example: user messages bot, bot replies to that message with this function
var messageUser = function (messageID, message, pageAccessToken) {
    FB.api('/'+messageID+'/messages?access_token='+pageAccessToken, 'post', {message: message}, function (res) {
        if(!res || res.error) {
            console.log(!res ? 'error occurred' : res.error);
            return;
        }
    });
};

// Gets a replacement user oauth token given an expired token
// This is currently not being used in the program
var getClientToken = function (oldToken, callback) {
    FB.api('/oauth/access_token?client_id='+clientID+'&client_secret='+clientSecret+'&grant_type=fb_exchange_token&fb_exchange_token='+oldToken, function (res) {
        if(!res || res.error) {
            return callback(res.error);
        }
        return callback(null, res.access_token);
    });
};

// Checks to make sure the message coming in is a specific command we recognize
var getMessageType = function(message) {
    if(message.toLowerCase().indexOf('register') !== -1) {
        return 'registration';
    } else if(message.toLowerCase().indexOf('withdraw') !== -1) {
        return 'withdraw';
    } else if(message.toLowerCase().indexOf('info') !== -1) {
        return 'info';
    } else if(message.toLowerCase().indexOf('history') !== -1) {
        return 'history';
    }
};

// Queries Facebook for an unread message
// TODO Figure out how to mark a messsage as read
// Currently, a message is read and processed, then another one is read when the call is made again, however it will return null if the bot answered last.
// Example: Loop 1: User messaged, bot replies. Loop 2: nothing if user has not replied to bot.
// Loop 1: User messaged, bot replies. Loop 2: User messaged, bot replies.
// TODO Encrypt messageID (The user ID is in it.) but also need it unencrypted to send messages.
var getNewMessage = function (callback) {
    getPageToken(function (error, pageAccessToken) {
        if(error) {
            return callback(error);
        }
        FB.api('/'+settings.facebook.name+'/conversations?access_token='+pageAccessToken, function (res) {
            if(!res || res.error) {
                return callback(!res ? 'error occurred' : res.error);
            }
            var messageID, message, fromID, fromName;
            for(var dataCounter = 0; dataCounter < res.data.length; dataCounter++) {
                if(res.data[dataCounter].unread_count > 0) {
                    messageID = res.data[dataCounter].id;
                    // Get latest message
                    message = res.data[dataCounter].messages.data[0].message;
                    // Make sure we are not replying to the bot
                    if(res.data[dataCounter].messages.data[0].from.id != settings.facebook.id) {// Don't use === because string vs int
                        fromID = res.data[dataCounter].messages.data[0].from.id;
                        fromName = res.data[dataCounter].messages.data[0].from.name;
                    }
                }
            }
            if(fromID === undefined) {
                return callback(null);
            }
            var callbackMessage = {
                messageID: messageID,
                message: message,
                fromID: sha256Hash(fromID), // Encrypt user's facebook unique ID
                pageAccessToken: pageAccessToken,
                type: getMessageType(message)
            };
            return callback(null, callbackMessage);
        });
    });
};

// Logic to register a user
// Parse message, verify address is legitimate, check to see if user exists, generate new wallet, store new user.
var registration = function (messageData) {
    parseRegisterMessage(messageData.message, function (error, dogeAddr) {
        if(error) {
            messageUser(messageData.messageID, error, messageData.pageAccessToken);
            return;
        }
        verifyAddr(dogeAddr, function (error) {
            if(error) {
                messageUser(messageData.messageID, error, messageData.pageAccessToken);
                return;
            }
            var dogeUser = {
                id: 'dogeUser:'+messageData.fromID,
                messageID: messageData.messageID,
                fromID: messageData.fromID,
                fromName: messageData.fromName,
                dogeAddr: dogeAddr,
                newAddr: ''//,
                //transactions: []
            };
            redis.read('dogeUser:'+messageData.fromID, function (error, oldDogeUser) {
                if(error) {
                    console.log('Error reading to redis');
                    console.log(error);
                    messageUser(messageData.messageID, 'There was an issue registering, please try again later.', messageData.pageAccessToken);
                    return;
                }
                if(oldDogeUser) {
                    messageUser(messageData.messageID, 'User already exists. Your deposit wallet is ' + oldDogeUser.newAddr, messageData.pageAccessToken);
                    return;
                }
                // Generate new wallet here
                client.getAccountAddress(messageData.fromID, function (error, newAddress) {
                    if(error) {
                        console.log('Error creating new address for user id ' + messageData.fromID);
                        console.log(error);
                        messageUser(messageData.messageID, 'There was an issue registering, please try again later.', messageData.pageAccessToken);
                        return;
                    }
                    dogeUser.newAddr = newAddress;
                    redis.store(dogeUser, function (error) {
                        if(error) {
                            console.log('Error storing to redis');
                            console.log(error);
                            return;
                        }
                        messageUser(messageData.messageID, 'Successfully registered ' + dogeAddr + '. Your deposit wallet is ' + newAddress, messageData.pageAccessToken);
                    });
                });
            });
        });
    });
};

// Withdraw message logic
// Check for existing user, parse message, get user's balance, send to old wallet
var withdraw = function (messageData) {
    redis.read('dogeUser:' + messageData.fromID, function (error, dogeUser) {
        if(error) {
            console.log(error);
            messageUser(messageData.messageID, 'There was an issue withdrawing at this time, please try again later.', messageData.pageAccessToken);
            return;
        }
        if(!dogeUser) {
            messageUser(messageData.messageID, 'You need to register, please try register <DogeCoin Address>', messageData.pageAccessToken);
            return;
        }
        parseCoin(messageData.message, function (error, coinData) {
            if(error) {
                console.log(error);
                messageUser(messageData.messageID, 'There was an issue withdrawing at this time, please try again later.', messageData.pageAccessToken);
                return;
            }
            var coinName = coinData.coinName;
            var coinAmount = coinData.coinAmount;
            switch(coinName) {
                case 'DOGE':
                    client.getBalance(messageData.fromID, function (error, balance) {
                        if(error) {
                            console.log(error);
                            messageUser(messageData.messageID, 'There was an issue withdrawing at this time, please try again later.', messageData.pageAccessToken);
                            return;
                        }
                        if(balance < coinAmount) {
                            messageUser(messageData.messageID, 'Not enough ' + coinName + ' to withdraw.', messageData.pageAccessToken);
                            return;
                        }
                        // withdraw
                        client.sendFrom(messageData.fromID, dogeUser.dogeAddr, coinAmount, function (error, transactionid) {
                            if(error) {
                                console.log(error);
                                messageUser(messageData.messageID, 'There was an issue withdrawing at this time, please try again later.', messageData.pageAccessToken);
                                return;
                            }
                            // No need because we can query the network for transactions
                            /*var transaction = {
                                id: transactionid,
                                from: null,
                                fromID: messageData.fromID,
                                to: dogeUser.dogeAddr,
                                toID: null,
                                coinData: coinData,
                                type: 'withdraw'
                            };
                            redis.store(transaction, function (error) {
                                if(error) {
                                    console.log(error);
                                    messageUser(messageData.messageID, 'There was an issue withdrawing at this time, please try again later.', messageData.pageAccessToken);
                                    return;
                                }
                                if(!dogeUser.transactions || dogeUser.transactions === undefined) {
                                    dogeUser.transactions = [];
                                }
                                dogeUser.transactions.push(transactionid);
                                redis.store(dogeUser, function (error) {
                                    if(error) {
                                        console.log(error);
                                        messageUser(messageData.messageID, 'There was an issue withdrawing at this time, please try again later.', messageData.pageAccessToken);
                                        return;
                                    }
                                });
                            });*/
                            messageUser(messageData.messageID, 'Successful withdraw of ' + coinAmount + ' ' + coinName, messageData.pageAccessToken);
                        });
                    });
                break;
                default:
                break;
            }
        });
    });
};

// History message logic
// Read existing user, get user's transactions, send them to user
// TODO, formulate the nice message with the transactions, currently returns the array
var history = function(messageData) {
    redis.read('dogeUser:' + messageData.fromID, function (error, dogeUser) {
        if(error) {
            console.log(error);
            messageUser(messageData.messageID, 'There was an issue returning history at this time, please try again later.', messageData.pageAccessToken);
            return;
        }
        if(!dogeUser) {
            messageUser(messageData.messageID, 'You need to register, please try register <DogeCoin Address>', messageData.pageAccessToken);
            return;
        }
        // Get transactions from the network or the user as a fallback
        // listtransactions [account] [count=10] [from=0]
        client.listTransactions(messageData.fromID, 75, function (error, transactions) {
            if(error) {
                console.log(error);
                messageUser(messageData.messageID, 'There was an issue returning history at this time, please try again later.', messageData.pageAccessToken);
                return;
            }
            messageUser(messageData.messageID, transactions, messageData.pageAccessToken);
        });
    });
};

// Info message logic
// Read user and return their deposit data
// TODO could make a more useful response
var info = function(messageData) {
    redis.read('dogeUser:' + messageData.fromID, function (error, dogeUser) {
        if(error) {
            console.log(error);
            messageUser(messageData.messageID, 'There was an issue returning your info at this time, please try again later.', messageData.pageAccessToken);
            return;
        }
        if(!dogeUser) {
            messageUser(messageData.messageID, 'You need to register, please try register <DogeCoin Address>', messageData.pageAccessToken);
            return;
        }
        messageUser(messageData.messageID, 'Deposit Address: ' + dogeUser.newAddr, messageData.pageAccessToken);
    });
};

// Get the new mentions of the Facebook Page
// If the Page as already replied, don't add it to the mention array
// TODO, add &since=' + (Date.now() - 120000) + '
var _getMentions = function(callback) {
    FB.api('/search?q=' + settings.facebook.name + '&type=post&access_token=' + accessToken, function (res) {
        if(!res || res.error) {
            return callback(!res ? 'error occurred' : res.error);
        }
        var mentionArray = [];
        for(var dataCounter = 0; dataCounter < res.data.length; dataCounter++) {
            if(res.data[dataCounter].message_tags && res.data[dataCounter].message_tags[0]) {
                for(var messageCounter = 0; messageCounter < res.data[dataCounter].message_tags[0].length; messageCounter++) {
                    if(res.data[dataCounter].message_tags[0][messageCounter].id == settings.facebook.id) {
                        var commentTracker = 0;
                        if(res.data[dataCounter].comments) {
                            for(var commentCounter = 0; commentCounter < res.data[dataCounter].comments.data.length; commentCounter++) {
                                // If the FROM ID of a comment is the same as the Facebook Page, increment count
                                if(res.data[dataCounter].comments.data[commentCounter].from.id == settings.facebook.id) {
                                    commentTracker++;
                                }
                            }
                            // The Facebook Page as not replied yet, lets add it to the array.
                            if(commentTracker === 0) {
                                var mentionObj = {
                                    fromID: res.data[dataCounter].from.id,
                                    status: res.data[dataCounter].message,
                                    statusID: res.data[dataCounter].id
                                };
                                mentionArray.push(mentionObj);
                            }
                        } else {
                            var mentionObj = {
                                fromID: res.data[dataCounter].from.id,
                                status: res.data[dataCounter].message,
                                statusID: res.data[dataCounter].id
                            };
                            mentionArray.push(mentionObj);
                        }
                    }
                }
            }
        }
        return callback(null, mentionArray);
    });
};

// Gets the page token of the Facebook Page in the settings file
var getPageToken = function(callback) {
    FB.api('/me/accounts?access_token=' + userToken, function (res) {
        if(!res || res.error) {
            return callback(!res ? 'error occurred' : res.error);
        }
        for(var dataCounter = 0; dataCounter < res.data.length; dataCounter++) {
            if(res.data[dataCounter].id == settings.facebook.id) {// Don't use === because string vs int
                return callback(null, res.data[dataCounter].access_token);
            }
        }
        return callback('Missing page access token.');
    });
};

// https://developers.facebook.com/docs/reference/api/status/
var replyStatus = function(statusID, message) {
    var statusIDArr = statusID.split('_');
    getPageToken(function (error, pageToken) {
        if(error) {
            console.log(error);
            return;
        }
        // Using a page token will a "Error finding the requested story" error.
        // Using a user token will cause "An unexpected error has occurred. Please retry your request later." BUT the post does show up!
        // https://developers.facebook.com/x/bugs/218862188300393/
        // https://developers.facebook.com/x/bugs/1378024742458739/
        // Currently leaving it as page token because that's the one we want when it starts to work
        FB.api('/' + statusIDArr[1] + '/comments', 'post', {message: message, access_token: pageToken}, function (res) {
            if(!res || res.error) {
                FB.api('/' + statusID + '/comments', 'post', {message: message, access_token: pageToken}, function (res) {
                    if(!res || res.error) {
                        console.log(!res ? 'error occurred' : res.error);
                        return;
                    }
                    console.log(res);
                });  
            }
            console.log(res);
        });
    });
};

// Function that is called in main.js
// Gets new message and then decides what type of message it is and sents it to that function
module.exports.start = function () {
    getNewMessage(function (error, messageData) {
        if(error) {
            console.log(error);
            return;
        }
        if(messageData) {
            switch(messageData.type) {
                case 'withdraw':
                    withdraw(messageData);
                break;
                case 'registration':
                    registration(messageData);
                break;
                case 'history':
                    history(messageData);
                break;
                case 'info':
                    info(messageData);
                break;
                default:
                    messageUser(messageData.messageID, 'Invalid command, please try another.', messageData.pageAccessToken);
                break;
            }
        }
    });
    getMentions(function (error, mentionArray) {
        if(error) {
            console.log(error);
            return;
        }
        console.log(mentionArray);
        // TODO For each mention in the mention array, reply to the user if the message is a tip.
    });
};