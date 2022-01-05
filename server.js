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
        user: 'cutropegame@gmail.com',
        pass: process.env.EMAIL_PASS
    }
});
    
const admin = require("firebase-admin");
const { start } = require('repl');
const { distance } = require('mathjs');
    
admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.DB_CRED)),
    databaseURL: process.env.DB_URL
});
    
const db = admin.database(),
    usersRef = db.ref('users');
    levelsRef = db.ref('levels');

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html')
});

io.on('connection', socket => {

    let authenticated = false;

    socket.emit('loginPrompt');
    
    socket.on('register', user => {
            if(!(user && user.email && user.password)) socket.emit('badData');

            const validateEmail = (email) => { 
                return email.match(
                    /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
                );
            };
            if(!validateEmail(user.email)){
                socket.emit('invalidEmail');
            } else {
                const hashedPassword = passwordHash.generate(user.password);
                usersRef.once('value', snap => {
                    let data = snap.val();
                    if(data == null) data = {};
                    if(data[_(user.email)] == null) {
                        const confirmationCode = Math.random().toString(36).slice(2);
                        data[_(user.email)] = {
                            password: hashedPassword,
                            levels: {
                                'name1': 15,
                                'name2': 4
                            },
                            status: 'pending',
                            confirmationCode: confirmationCode
                        }
                        usersRef.set(data);
                        const mailOptions = {
                            to: user.email,
                            subject: "Swing Rope Confirmation Code",
                            text: `Your confirmation code is: ${confirmationCode}`,
                            }
                        transporter.sendMail(mailOptions, function(error, info){
                            if (error) {
                                console.log(error);
                                data[_(user.email)] = null;
                                usersRef.set(data);
                                socket.emit('failedEmail');
                            } else {
                                socket.emit('codePrompt');
                            }
                        });
                    } else {
                        socket.emit('emailTaken');
                    }
                });
            }
        });
        socket.on('codeAttempt', user => {
            if(!(user && user.email && user.code)) socket.emit('badData');
            usersRef.once('value', snap => {
                let data = snap.val();
                if(data == null) data = {};
                if(data[_(user.email)].status != 'pending'){
                    socket.emit('alreadyConfirmed');
                } else {
                    if(data[_(user.email)].confirmationCode == user.code){
                        data[_(user.email)].status = 'active';
                        usersRef.set(data);
                        socket.emit('loginPrompt');
                    } else{
                        socket.emit('wrongCode');
                    }
                }
            });
        });
        socket.on('loginAttempt', user => {
            if(!(user && user.email && user.password)) socket.emit('badData');
            else {
                if(user.email == 'admin' && user.password == process.env.ADMIN_PASS){
                    authenticated = 'admin';
                    socket.emit('admin');
                } else {
                    usersRef.once('value', snap => {
                        let data = snap.val();
                        if(data == null) data = {};
                        if(data[_(user.email)] == null){
                            socket.emit('emailNotFound');
                        } else {
                            if(passwordHash.verify(user.password, data[_(user.email)].password)){
                                if(data[_(user.email)].status == 'pending'){
                                    socket.emit('codePrompt');
                                } else {
                                    authenticated = user;
                                    socket.emit('authenticated');
                                }
                            } else {
                                socket.emit('wrongPassword');
                            }
                        }
                    });
                }
            }
        });

        socket.on('newLevel', info => {
            if(authenticated != 'admin'){
                socket.emit('notAuthorized');
            } else {
                if(!(info && info.lines && info.goal && info.bounces && info.start)){
                    socket.emit('badData');
                } else {
                    levelsRef.once('value', snap => {
                        let data = snap.val();
                        if(data == null) data = {};
                        data[info.id] = {
                            lines: info.lines,
                            goal: info.goal, //line
                            bounces: info.bounces,
                            start: info.start //point
                        }
                        levelsRef.set(data);
                    });
                }
            }
        });
        socket.on('getLevelIds', () => {
            if(!authenticated){
                socket.emit('notAuthenticated');
            } else {
                levelsRef.once('value', snap => {
                    let data = snap.val();
                    if(data == null) data = {};
                    socket.emit('levelIds', Object.keys(data));
                });
            }
        });
        socket.on('getLevelData', id => {
            if(!authenticated){
                socket.emit('notAuthenticated');
            } else {
                levelsRef.once('value', snap => {
                    let data = snap.val();
                    if(data == null || data[id] == null){
                        socket.emit('levelNotFound');
                    } else {
                        socket.emit('levelData', data[id]);
                    }
    
                });
            }
        });
        socket.on('playLevel', info => {
            if(!authenticated){
                socket.emit('notAuthenticated');
            } else {
                if(!(info && info.id && info.angle)){
                    socket.emit('badData');
                } else {
                    levelsRef.once('value', snap => {
                        let data = snap.val();
                        if(data == null) data = {};
                        if(data[info.id] == null){
                            socket.emit('levelDNE');
                        } else {
                            let bouncesLeft = data[info.id].bounces;
                            const lines = data[info.id].lines;
                            const goal = data[info.id].goal;
                            let currPoint = data[info.id].start;
                            let currAngle= data[info.id].angle
                            let instructions = [currPoint];
                            while(bounces >= 0){
                                let nextPoint = currPoint;
                                let bounceLine = null;
                                for(let key of Object.keys(lines)){
                                    try{
                                        let intersectPoint = calculateIntersection(
                                            currPoint, 
                                            {x: currPoint.x + 500 * Math.cos(currAngle), y: currPoint.y + Math.sin(currAngle)},
                                            lines[key].p1,
                                            lines[key].p2);
                                        if(distance(currPoint, intersectPoint) > distance(currPoint, nextPoint)){
                                            nextPoint = intersectPoint;
                                            bounceLine = lines[key];
                                        }
                                    } catch(e){
                                        //Doesn't intersect, so no need to update nextPoint
                                    }
                                }
                                try{
                                    let intersectPoint = calculateIntersection(
                                        currPoint, 
                                        {x: currPoint.x + 500 * Math.cos(currAngle), y: currPoint.y + Math.sin(currAngle)},
                                        goal.p1,
                                        goal.p2);
                                    if(distance(currPoint, intersectPoint) > distance(currPoint, nextPoint)){
                                        nextPoint = goal;
                                    }
                                } catch(e){
                                    //Doesn't intersect, so no need to update nextPoint
                                }

                                instructions.push(nextPoint);

                                if(nextPoint == goal){
                                    socket.emit('animate', instructions)
                                }

                                //Find new angle

                                v = {
                                    x: bounceLine.p2.x - bounceLine.p1.x,
                                    y: bounceLine.p2.y - bounceLine.p1.y
                                }

                                let magV = Math.sqrt( v.x * v.x + v.y * v.y );
                                let angleV = Math.acos(v.x / magV)

                                currAngle = Math.abs(2 * angleV - currAngle);
                                if(currAngle >= 360) currAngle = currAngle % 360;
                                currPoint = nextPoint;
                                
                                bouncesLeft--;
                            }
                            socket.emit('animatewkefbiwbaeifgbi', instructions);
                        }
                    });
                }
            }
        });

});

function calculateIntersection(p1, p2, p3, p4) {

    let d1 = (p1.x - p2.x) * (p3.y - p4.y); 
    let d2 = (p1.y - p2.y) * (p3.x - p4.x); 
    let d  = (d1) - (d2);

    if(d == 0) {
      throw new Error('Number of intersection points is zero or infinity.');
  }

    let u1 = (p1.x * p2.y - p1.y * p2.x);
    let u4 = (p3.x * p4.y - p3.y * p4.x); 
    
    let u2x = p3.x - p4.x; 
    let u3x = p1.x - p2.x;
    let u2y = p3.y - p4.y; 
    let u3y = p1.y - p2.y;
    
    let px = (u1 * u2x - u3x * u4) / d;
    let py = (u1 * u2y - u3y * u4) / d;
    
    let p = { x: px, y: py };

    return p;
}

function distance(p1, p2){
    return Math.sqrt(
        (p2.y-p1.y) * (p2.y-p1.y) +
        (p2.x-p1.x) * (p2.x-p1.x)
    );
}
function intersectsAt(start, angle, )

function _(email){
    return email.replaceAll('.', '>');
}

server.listen(process.env.PORT || 3000);

