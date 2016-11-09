var express = require('express');
var rbx = require('roblox-js');
var fs = require('fs');
var crypto = require('crypto');
var validator = require('validator');
var bodyParser = require('body-parser');

var app = express();
var port = process.env.PORT || 8080;
var settings = require('./settings.json');
var key = settings.key;

app.set('env', 'production');

function login () {
  rbx.login(settings.username, settings.password);
}
setInterval(login, 86400000);
login();

var inProgress = {};
var completed = {};

var dir = './players';

if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir);
}

fs.readdirSync('./players').forEach(function (file) { // This is considered a part of server startup and following functions could error anyways if it isn't complete, so using synchronous instead of asynchronous is very much intended.
  completed[file] = true;
});

function sendErr (res, json, status) {
  res.status(status || 500).json(json);
}

function validatorType (type) {
  switch (type) {
    case 'int':
      return validator.isInt;
    case 'safe_string':
      return validator.isAlphanumeric;
    case 'boolean':
      return validator.isBoolean;
    default:
      return function () {
        return true;
      };
  }
}

function processType (type, value) {
  switch (type) {
    case 'int':
      return parseInt(value, 10);
    case 'boolean':
      return (value === 'true');
    default:
      return value;
  }
}

function verifyParameters (res, validate, requiredFields, optionalFields) {
  var result = {};
  if (requiredFields) {
    for (var index in requiredFields) {
      var type = requiredFields[index];
      var use = validatorType(type);

      var found = false;
      for (var i = 0; i < validate.length; i++) {
        var value = validate[i][index];
        if (value) {
          if (use(value)) {
            result[index] = processType(type, value);
            found = true;
          } else {
            sendErr(res, {error: 'Parameter "' + index + '" is not the correct data type.', id: null});
            return false;
          }
          break;
        }
      }
      if (!found) {
        sendErr(res, {error: 'Parameter "' + index + '" is required.', id: null});
        return false;
      }
    }
  }
  if (optionalFields) {
    for (index in optionalFields) {
      type = optionalFields[index];
      use = validatorType(type);
      for (i = 0; i < validate.length; i++) {
        value = validate[i][index];
        if (value) {
          if (use(value)) {
            result[index] = processType(type, value);
          } else {
            sendErr(res, {error: 'Parameter "' + index + '" is not the correct data type.', id: null});
            return false;
          }
          break;
        }
      }
    }
  }
  return result;
}

function authenticate (req, res, next) {
  if (req.body.key === key) {
    next();
  } else {
    sendErr(res, {error: 'Incorrect authentication key', id: null}, 401);
  }
}

function changeRank (amount) {
  return function (req, res, next) {
    var requiredFields = {
      'group': 'int',
      'target': 'int'
    };
    var validate = [req.params];

    var opt = verifyParameters(res, validate, requiredFields);
    if (!opt) {
      return;
    }

    var group = opt.group;
    rbx.getRankInGroup(group, opt.target)
    .then(function (rank) {
      rbx.getRoles(group)
      .then(function (roles) {
        // Roles is actually sorted on ROBLOX's side and returned the same way
        for (var i = 0; i < roles.length; i++) {
          var role = roles[i];
          if (role.Rank === rank) {
            var newRank = roles[i + amount];
            if (!newRank) {
              sendErr(res, {error: 'Rank change is out of range'});
              return;
            }
            var name = newRank.Name;
            opt.roleset = newRank.ID;
            rbx.setRank(opt)
            .then(function (roleset) {
              res.json({error: null, data: {newRoleSetId: roleset, newRankName: name, newRank: newRank.Rank}, message: 'Successfully changed rank of user ' + opt.target + ' to rank "' + name + '" in group ' + opt.group});
            })
            .catch(function (err) {
              sendErr(res, {error: 'Change rank failed: ' + err.message});
            });
            return;
          }
        }
      });
    });
  };
}

function getPlayersWithOpt (req, res, next) {
  var uid = crypto.randomBytes(5).toString('hex');
  var requiredFields = {
    'group': 'int'
  };
  var optionalFields = {
    'rank': 'int',
    'limit': 'int',
    'online': 'boolean'
  };
  var validate = [req.params, req.query];

  var opt = verifyParameters(res, validate, requiredFields, optionalFields);
  if (!opt) {
    return;
  }

  inProgress[uid] = 0;
  var players = rbx.getPlayers(opt);

  inProgress[uid] = players.getStatus;
  players.promise.then(function (info) {
    if (inProgress[uid]) { // Check if job was deleted
      completed[uid] = true;
      var file = fs.createWriteStream('./players/' + uid);
      file.write(JSON.stringify(info, null, ' '));
    }
    info = null; // Bye, bye
  });
  res.json({error: null, data: {uid: uid}});
}

app.use(bodyParser.json());

app.post('/setRank/:group/:target/:rank', authenticate, function (req, res, next) {
  var requiredFields = {
    'group': 'int',
    'rank': 'int',
    'target': 'int'
  };
  var validate = [req.params];
  var opt = verifyParameters(res, validate, requiredFields);
  if (!opt) {
    return;
  }
  rbx.setRank(opt)
  .then(function (roleset) {
    res.json({error: null, data: {newRoleSetId: roleset}, message: 'Successfully changed rank of user ' + opt.target + ' to roleset ' + roleset + ' in group ' + opt.group});
  })
  .catch(function (err) {
    sendErr(res, {error: 'Set rank failed: ' + err.message});
  });
});

app.post('/handleJoinRequest/:group/:username/:accept', authenticate, function (req, res, next) {
  var requiredFields = {
    'group': 'int',
    'username': 'string',
    'accept': 'boolean'
  };
  var validate = [req.params];
  var opt = verifyParameters(res, validate, requiredFields);
  if (!opt) {
    return;
  }
  rbx.handleJoinRequest(opt)
  .then(function () {
    res.json({error: null, message: 'Successfully ' + (opt.accept ? 'accepted' : 'declined') + ' ' + opt.username});
  })
  .catch(function (err) {
    sendErr(res, {error: 'Handle join request failed: ' + err.message});
  });
});

app.post('/message/:recipient/', authenticate, function (req, res, next) {
  var requiredFields = {
    'recipient': 'int',
    'subject': 'string',
    'body': 'string'
  };
  var validate = [req.params, req.body];
  var opt = verifyParameters(res, validate, requiredFields);
  if (!opt) {
    return;
  }
  rbx.message(opt)
  .then(function () {
    res.json({error: null, message: 'Messaged user ' + opt.recipient + ' with subject "' + opt.subject + '"'});
  })
  .catch(function (err) {
    sendErr(res, {error: 'Message failed: ' + err.message});
  });
});

app.post('/shout/:group', authenticate, function (req, res, next) {
  var requiredFields = {
    'group': 'int'
  };
  var optionalFields = {
    'message': 'string'
  };
  var validate = [req.params, req.body];
  var opt = verifyParameters(res, validate, requiredFields, optionalFields);
  if (!opt) {
    return;
  }
  rbx.shout(opt)
  .then(function () {
    res.json({error: null, message: 'Shouted in group ' + opt.group});
  })
  .catch(function (err) {
    sendErr(res, {error: 'Error: ' + err.message});
  });
});

app.post('/promote/:group/:target', authenticate, changeRank(1));
app.post('/demote/:group/:target', authenticate, changeRank(-1));

app.post('/getPlayers/make/:group/:rank', getPlayersWithOpt);
app.post('/getPlayers/make/:group', getPlayersWithOpt);

app.post('/getPlayers/delete/:uid', authenticate, function (req, res, next) {
  var uid = req.params.uid;
  function fail () {
    sendErr(res, {error: 'Invalid ID or the job is not complete'});
  }
  if (uid.length === 10 && validator.isHexadecimal(uid)) {
    var path = './players/' + uid;
    if (completed[uid]) {
      completed[uid] = false;
      inProgress[uid] = null;
      fs.unlink(path, function (err) { // Since the uid was verified to be hex this shouldn't be a security issue
        if (err) {
          next(err);
        } else {
          res.json({error: null, message: 'File deleted'});
        }
      });
    }
  } else if (inProgress[uid]) {
    inProgress[uid] = null;
    res.json({error: null, message: 'Removed from list, the job itself has not been stopped'});
  } else {
    fail();
  }
});

app.get('/getPlayers/retrieve/:uid', function (req, res, next) {
  var uid = req.params.uid;
  function fail () {
    sendErr(res, {error: 'Invalid ID'});
  }
  if (uid.length === 10 && validator.isHexadecimal(uid)) {
    var path = './players/' + uid;
    var complete = completed[uid];
    var progress = inProgress[uid];
    if (complete) {
      fs.stat(path, function (err) {
        if (err) {
          next(err);
        } else {
          res.append('Content-Type', 'application/json');
          res.write('{"error":null,"data":{"progress":100,"complete":true,');
          var stream = fs.createReadStream(path);
          var first = true;
          stream.on('data', function (data) {
            if (first) {
              res.write(data.toString().substring(1));
              first = false;
            } else {
              res.write(data);
            }
          });
          stream.on('end', function () {
            res.end('}');
          });
        }
      });
    } else if (progress) {
      sendErr(res, {error: 'Job is still processing', data: {complete: false, progress: progress()}}, 200);
    } else {
      fail();
    }
  } else {
    fail();
  }
});

app.use(function (err, req, res, next) {
  console.error(err.stack);
  sendErr(res, {error: 'Internal server error'});
});

app.listen(port, function () {
  console.log('Listening');
});
