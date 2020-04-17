require('dotenv').config();
const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: process.env.DB_URL,
});

const db = admin.firestore();
const tok = process.env.DUMMY_FCM_TOKEN;

// Create and Deploy Your First Cloud Functions
// https://firebase.google.com/docs/functions/write-firebase-functions

exports.helloWorld = functions.https.onRequest((req, res) => {
  res.send('Hello from Firebase!');
});

exports.listenOrderStatus = functions.firestore
    .document('orders/{uid}')
    .onUpdate((change, context) => {
      // Documents
      const previousVal = change.before.data();
      const currentVal = change.after.data();

      // Order Statuses
      const prevOS = previousVal.orderStatus;
      const currOs = currentVal.orderStatus;

      if (prevOS.length === currOs.length) {
        console.log('no order status changes');
        return null;
      };

      return new Promise(async (resolve, reject) => {
        const clientData = await db
            .collection('clients')
            .doc(currentVal.userUid);
        console.log(clientData);
        console.log('previousVal =>', previousVal);

        const payLoad = {
          notification: {
            body: 'This is the body',
            title: currOs[currOs.length -1],
          },
        };

        await admin.messaging().sendToDevice(tok, payLoad)
            .then((res) => console.log(res))
            .catch((res) => console.log(res));

        console.log('Success');
        resolve('Success');
      }).catch((res) => {
        console.log(res);
        reject(res);
      });
    });
