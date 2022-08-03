# slant.pro

This web app is built with vanilla Javascript and CSS on the frontend, and [Socket.io](https://socket.io/) for **all** backend functionality. It uses the 
[Firebase Realtime Database](https://firebase.google.com/docs/database) to store level data, and user data, including hashed credentials 
(using [password-hash](https://www.npmjs.com/package/password-hash)) for a manually implemented authentication system.

## Problems

The technologies chosen for this project are used poorly. A lot of the usage of Socket.io events just mimics a REST API endpoint
in a more verbose way and does not take advantage of the Socket.io's ability to emit Websockets to all connected users. For example, creating a 
level requires the client to emit a `newLevel` event with the required information. The server then excecutes logic and emits one of the following
events to **only** that user: `notAuthenticated`, `badData`, `invalidName`, `tooManyUnverifiedLevels`, `nameTaken`, or `levelCreated`. This is one-to-one
with a REST API endpoint, where the user makes a POST request to something like `/levels/add`. The other glaring issue is that the Realtime Database
is not used as intended. It should be used directly from the client app, since it already uses Websockets under the hood. Instead, this project creates a 
Websocket connection to the server, and then the server creates a Websocket connection to the Realtime Database.

## Future

No plans exist to revamp this project, but other big things are in the works :fire:
