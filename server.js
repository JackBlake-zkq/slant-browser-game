require('dotenv').config()

const express = require('express'),
    app=express(),
    http = require('http'),
    server = http.createServer(app),
    { Server } = require('socket.io'),
    io = new Server(server),
    passwordHash = require('password-hash');

const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'Gmail',
    auth: {
        user: 'ballshotgame@gmail.com',
        pass: process.env.EMAIL_PASS
    }
});
    
const admin = require("firebase-admin");
const { info } = require('console');
    
admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.DB_CRED)),
    databaseURL: process.env.DB_URL
});
    
const db = admin.database(),
    usersRef = db.ref('users'),
    levelsRef = db.ref('levels');

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html')
});

io.on('connection', socket => {

    let authenticated = false;

    socket.emit('loginPrompt');
    
    socket.on('register', user => {
        if(!(user && user.email 
            && typeof user.password == 'string' && user.password
            && typeof user.username == 'string' && user.username)){
                socket.emit('badData');
                return;
            }

        if(!validateEmail(user.email)){
            socket.emit('invalidEmail');
            return;
        }
        if(!user.username.match(/^[A-Za-z0-9]+$/)){ //check if alphanumeric
            socket.emit('invalidUsername');
            return;
        }
        const hashedPassword = passwordHash.generate(user.password);
        usersRef.once('value', snap => {
            let data = snap.val();
            if(data == null) data = {};
            if(data[_(user.email)] != null){
                socket.emit('emailTaken');
                return;
            }
            for(let [key, value] of Object.entries(data)){
                if(value.username == user.username){
                    socket.emit('usernameTaken');
                    return;
                }
            }
            const confirmationCode = Math.random().toString(36).slice(2);
            data[_(user.email)] = {
                username: user.username,
                password: hashedPassword,
                levels: {},
                status: 'pending',
                confirmationCode: confirmationCode
            }
            usersRef.set(data);
            const mailOptions = {
                to: user.email,
                subject: "slant.pro Confirmation Code",
                text: `Your confirmation code is: ${confirmationCode}`,
                }
            transporter.sendMail(mailOptions, function(error, info){
                console.log(info);
                if (error) {
                    console.log(error);
                    data[_(user.email)] = null;
                    usersRef.set(data);
                    socket.emit('failedEmail');
                    return;
                }
                socket.emit('codePrompt');
            });
        });
    });
    socket.on('codeAttempt', user => {
        if(!(user && typeof user.code == 'string' && user.code
            && typeof user.email == 'string' && user.email)){
            socket.emit('badData');
            return;
        } 
        if(!validateEmail(user.email)){
            socket.emit('invalidEmail');
            return;
        }
        usersRef.once('value', snap => {
            let data = snap.val();
            if(data == null) data = {};
            if(data[_(user.email)].status != 'pending'){
                socket.emit('alreadyConfirmed');
                return;
            }
            if(data[_(user.email)].confirmationCode != user.code){
                socket.emit('wrongCode');
                return;
            }
            data[_(user.email)].status = 'active';
                usersRef.set(data);
                socket.emit('loginPrompt');
        });
    });
    socket.on('loginAttempt', user => {
        if(!(user && user.email 
            && typeof user.password == 'string' && user.password)){
                socket.emit('badData');
                return;
            }

        if(!validateEmail(user.email)){
            socket.emit('invalidEmail');
            return;
        }
        usersRef.once('value', snap => {
            let data = snap.val();
            if(data == null) data = {};
            if(data[_(user.email)] == null){
                socket.emit('emailNotFound');
                return
            }
            if(!passwordHash.verify(user.password, data[_(user.email)].password)){
                socket.emit('wrongPassword');
                return;
            }
            if(data[_(user.email)].status == 'pending'){
                socket.emit('codePrompt');
                return;
            }
            authenticated = {
                username: data[_(user.email)].username,
                email: user.email
            };
            socket.emit('authenticated');
            let cookie = '';
            for(let i = 0; i < 5; i++){
                cookie+=Math.random().toString(36).substring(2, 15);
            }
            data[_(user.email)].cookie = cookie;
            usersRef.set(data);
            socket.emit('saveCookie', cookie);
        });
    });

    socket.on('logout', () => {
        if(!authenticated){
            socket.emit('notAuthenticated');
            return;
        } 
        usersRef.once('value', snap => {
            let data = snap.val();
            data[_(authenticated.email)].cookie = null;
            usersRef.set(data);
            authenticated=false;
            socket.emit('loginPrompt');
        });
    });

    socket.on('rememberMe', cookie => {
        if(typeof cookie != 'string' || !cookie) return;
        usersRef.orderByChild('cookie').equalTo(cookie).once('value', snap => {
            snap.forEach( child => {
                authenticated = {
                    username: child.val().username,
                    email: child.key.replace(/>/g, '.')
                };
                socket.emit('authenticated');
                return;
            });
        });
    });

    socket.on('newLevel', info => {
        if(!authenticated){
            socket.emit('notAuthenticated');
            return;
        }
        if(!(info && info.lines && info.goal && info.start && info.name)){
            socket.emit('badData');
            return;
        }
        if(!info.name.match(/^[A-Za-z0-9]+$/)){ //check if alphanumeric
            socket.emit('invalidName');
            return;
        }
        //verify integrity of each element
        for(let [key, value] of Object.entries(info.lines)){
            //make sure all lines are valid
            if(!isValidLine(value)) {
                socket.emit('badData');
                return;
            }
        }
        if(!(isValidLine(info.goal)

            && isValidPoint(info.start)   
            //verify type of bounces
            && typeof info.bounces == 'number'

            && info.bounces >= 0
            //verify type of name
            && typeof info.name == 'string'

            && info.name  //non-empty
            )){
                socket.emit('badData');
                return;
            }
            levelsRef.orderByChild('creator').equalTo(authenticated.username).once('value', snap => {
                let count = 0;
                snap.forEach( child => {
                    if(child.val().status == 'unverified'){
                        count++;
                    }
                });
                if(count >= 5){
                    socket.emit('tooManyUnverifiedLevels');
                    return;
                }
                info.lines['defaultLine1'] = {
                    p1: {
                        x:-50,
                        y:-50
                    },
                    p2: {
                        x:-50,
                        y:50
                    }
                }
                info.lines['defaultLine2'] = {
                    p1: {
                        x:-50,
                        y:-50
                    },
                    p2: {
                        x:50,
                        y:-50
                    }
                }
                info.lines['defaultLine3'] = {
                    p1: {
                        x:-50,
                        y:50
                    },
                    p2: {
                        x:50,
                        y:50
                    }
                }
                info.lines['defaultLine4'] = {
                    p1: {
                        x:50,
                        y:-50
                    },
                    p2: {
                        x:50,
                        y:50
                    }
                }
    
                levelsRef.once('value', snap => {
                    let data = snap.val();
                    if(data == null) data = {};
                    if(data[info.name] != null){
                        socket.emit('nameTaken')
                        return;
                    }
                    data[info.name] = {
                        lines: info.lines,
                        goal: info.goal, //line
                        bounces: info.bounces,
                        start: info.start, //point
                        status: 'unverified',
                        creator: authenticated.username
                    }
                    levelsRef.set(data);
                    socket.emit('levelCreated', info.name);
                });
            });
    });
    socket.on('deleteLevel', name => {
        if(!authenticated){
            socket.emit('notAuthenticated');
            return;
        } 
        levelsRef.orderByChild('creator').equalTo(authenticated.username).once('value', snap => {
            let data = snap.val();
            if(data == null || data[name] == null){
                socket.emit('levelNotFound');
                return;
            } 
            data[name] = null;
            levelsRef.set(data);
            usersRef.once('value', snap => {
                let users = snap.val();
                for(let key of Object.keys(users)){
                    if(users[key].levels) users[key].levels[name] = null;
                }
                usersRef.set(data);
            })
            socket.emit('levelDeleted');
        })
    });
    socket.on('getDisplayInfo', info => {
        if(!authenticated){
            socket.emit('notAuthenticated');
            return;
        } 
        if(!info){
            socket.emit('badData');
            return;
        }
        if(!(info.sortBy== 'timestamp' || info.sortBy == 'downloads')){
            socket.emit('badData');
            return;
        }
        if(!(info.searchType == 'name' || info.searchType == 'creator')){
            socket.emit('badData');
            return;
        }
        if(!(info.searchInput === '' || info.searchInput.match(/^[A-Za-z0-9]+$/))){
            socket.emit('badData');
            return;
        }
        levelsRef.orderByChild(info.sortBy).limitToLast(50).once('value', snap => {
            let verifiedLevels = [];
            snap.forEach( child => {
                let key = child.key;
                let value = child.val();
                if(value.status == 'verified'){
                    let toSearch = key;
                    if(info.searchType == 'creator') toSearch = value.creator;
                    if(toSearch.includes(info.searchInput)){
                        verifiedLevels.push({
                            name: key,
                            creator:value.creator,
                        });
                    }
                }
            });
            verifiedLevels = verifiedLevels.reverse();
            socket.emit('displayInfo', verifiedLevels);
        });
    });
    socket.on('getLevelData', name => {
        if(!authenticated){
            socket.emit('notAuthenticated');
            return;
        } 
        levelsRef.once('value', snap => {
            let data = snap.val();
            if(data == null || data[name] == null){
                socket.emit('levelNotFound');
                return;
            } 
            if(data[name].status == 'unverified'){
                if(data[name].creator != authenticated.username){
                    socket.emit('levelNotFound');
                    return;
                }
            }
            socket.emit('levelData', {
                start: data[name].start,
                goal: data[name].goal,
                lines: data[name].lines,
                bounces: data[name].bounces
            });
            if(!data[name].downloaders) {
                data[name].downloaders = [authenticated.username];
                data[name].downloads = 1;
                levelsRef.set(data);
                return;
            }
            let downloaders = Array.from(data[name].downloaders);
            if(!downloaders.includes(authenticated.username)) {
                downloaders.push(authenticated.username);
                data[name].downloaders = downloaders;
                data[name].downloads++;
                levelsRef.set(data);
            }
        });
    });
    socket.on('getMyLevels', () => {
        if(!authenticated){
            socket.emit('notAuthenticated');
            return;
        } 
        levelsRef.once('value', snap => {
            let data = snap.val();
            if(data == null) data = {};
            let myLevels = [];
            for(let [key, value] of Object.entries(data)){
                if(value.creator == authenticated.username){
                    myLevels.push({
                        name: key,
                        status: value.status,
                    });
                }
            }
            socket.emit('myLevels', myLevels);
        });
    });
    socket.on('playLevel', info => {
        if(!authenticated){
            socket.emit('notAuthenticated');
            return;
        } 
        if(!(info 
            && typeof info.name == 'string' && info.name 
            && typeof info.angle == 'number'
            && info.angle >=0 && info.angle < 360)){
            socket.emit('badData');
            return;
        }
        levelsRef.once('value', snap => {
            let data = snap.val();
            if(data == null) data = {};
            if(data[info.name] == null){
                socket.emit('levelDNE');
                return;
            } 
            if(data[info.name].status == 'unverified' &&  data[info.name].creator != authenticated.username){
                socket.emit('levelDNE');
                return;
            }
            let bouncesLeft = data[info.name].bounces;
            const lines = data[info.name].lines;
            const goal = data[info.name].goal;
            let currPoint = data[info.name].start;
            let currAngle = info.angle;
            let instructions = [currPoint];
            let prevBounceLine = null;
            while(bouncesLeft >= 0){
                let nextPoint = {x:1000, y:1000};
                let bounceLine = null;
                for(let [key, value] of Object.entries(lines)){
                    if(value == prevBounceLine) continue;
                    let intersectPoint = intersect(
                        currPoint, 
                        {x: currPoint.x + 500 * Math.cos(degreesToRadians(currAngle)), y: currPoint.y + 500 * Math.sin(degreesToRadians(currAngle))},
                        value.p1,
                        value.p2);
                    if(intersectPoint && distance(currPoint, intersectPoint) < distance(currPoint, nextPoint)){
                        nextPoint = intersectPoint;
                        bounceLine = value;
                    }
                }
                let intersectPoint = intersect(
                    currPoint, 
                    {x: currPoint.x + 500 * Math.cos(degreesToRadians(currAngle)), y: currPoint.y + 500 * Math.sin(degreesToRadians(currAngle))},
                    goal.p1,
                    goal.p2);
                if(intersectPoint && distance(currPoint, intersectPoint) <= distance(currPoint, nextPoint)){
                    nextPoint = intersectPoint;
                    instructions.push(nextPoint);
                    if(data[info.name].status == 'unverified' &&  data[info.name].creator == authenticated.username){
                        data[info.name].status = 'verified';
                        data[info.name].timestamp = Date.now();
                        levelsRef.set(data);
                        socket.emit('verified');
                    } 
                    usersRef.once('value', snap => {
                        let users = snap.val();
                        if(users[_(authenticated.email)].levels == null) users[_(authenticated.email)].levels = {}
                        if(typeof users[_(authenticated.email)].levels[info.name] == 'number'){
                            if(data[info.name].bounces - bouncesLeft < users[_(authenticated.email)].levels[info.name]){
                                users[_(authenticated.email)].levels[info.name] = data[info.name].bounces - bouncesLeft;
                                socket.emit('pb');
                            } else {
                                socket.emit('npb');
                            }
                        } else {
                            users[_(authenticated.email)].levels[info.name] = data[info.name].bounces - bouncesLeft;
                            socket.emit('pb');
                        }
                        usersRef.set(users);
                    });
                    socket.emit('animateClear', instructions);
                    return;
                }

                instructions.push(nextPoint);

                //Find new angle and set currAngle to It
                v = {
                    x: bounceLine.p2.x - bounceLine.p1.x,
                    y: bounceLine.p2.y - bounceLine.p1.y
                }

                let magV = Math.sqrt( v.x * v.x + v.y * v.y );
                let angleV = radiansToDegrees(Math.acos(v.x / magV));
                if (v.y < 0) angleV = 360 - angleV;

                currAngle = 2 * angleV - currAngle
                while(currAngle < 0){
                    currAngle += 360;
                } 
                if(currAngle >= 360) currAngle %= 360;
                //set currPoint to point that it just bounced at
                currPoint = nextPoint;
                
                prevBounceLine = bounceLine;

                bouncesLeft--;
            }
            socket.emit('animateFail', instructions);
        });
    });
    socket.on('getLeaderboard', levelName => {
        if(!authenticated){
            socket.emit('notAuthenticated');
            return;
        }
        levelsRef.once('value', snap => {
            let data = snap.val();
            if(data == null) data = {};
            if(data[levelName] == null){
                socket.emit('levelDNE');
                return;
            }
        })
        let leaderboard = [];
        usersRef.orderByChild(`levels/${levelName}`).startAt(0).once('value', snap => {
            snap.forEach( child => {
                let value = child.val();
                leaderboard.push({
                    username: value.username,
                    bounces: value.levels[levelName]
                });
            });
            socket.emit('leaderboard', leaderboard);
        })
    });
});


function validateEmail(email) { 
    return email.match(
        /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
    );
};

function degreesToRadians(degrees) {
  return degrees * (Math.PI / 180);
}
function radiansToDegrees(radians){
    return radians * (180 / Math.PI);
}
function isValidLine(line){
    return line && line.p1 && line.p2 && isValidPoint(line.p1) && isValidPoint(line.p2);
}
function isValidPoint(point){
    return typeof point.x == 'number' && typeof point.y == 'number'
        && pointWithinRange(point);
}
function pointWithinRange(point){
    return (point.x <= 50 && point.x >= -50 && point.y <= 50 && point.y >= -50);
}

// line intercept math by Paul Bourke http://paulbourke.net/geometry/pointlineplane/
// Determine the intersection point of two line segments
// Return FALSE if the lines don't intersect
function intersect(p1, p2, p3, p4) {

    // Check if none of the lines are of length 0
      if ((p1.x === p2.x && p1.y === p2.y) || (p3.x === p4.x && p3.y === p4.y)) {
          return false
      }
  
      denominator = ((p4.y - p3.y) * (p2.x - p1.x) - (p4.x - p3.x) * (p2.y - p1.y))
  
    // Lines are parallel
      if (denominator === 0) {
          return false;
      }
  
      let ua = ((p4.x - p3.x) * (p1.y - p3.y) - (p4.y - p3.y) * (p1.x - p3.x)) / denominator
      let ub = ((p2.x - p1.x) * (p1.y - p3.y) - (p2.y - p1.y) * (p1.x - p3.x)) / denominator
  
    // is the intersection along the segments
      if (ua < 0 || ua > 1 || ub < 0 || ub > 1) {
        return false;
      }
  
    // Return a object with the x and y coordinates of the intersection
      let x = p1.x + ua * (p2.x - p1.x)
      let y = p1.y + ua * (p2.y - p1.y)
  
      return {x, y}
  }

function distance(p1, p2){
    return Math.sqrt(
        (p2.y-p1.y) * (p2.y-p1.y) +
        (p2.x-p1.x) * (p2.x-p1.x)
    );
}

function _(email){
    return email.replace(/\./g, '>');
}



server.listen(process.env.PORT || 3000);

