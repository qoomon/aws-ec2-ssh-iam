'use strict';

let AWS = require('aws-sdk');
let S3 = new AWS.S3();
let IAM = new AWS.IAM();

// configuration
let s3Bucket = process.env.S3_BUCKET;
console.log('s3Bucket: ', s3Bucket);

let getAuthorizedKeysForUser = (userName) => {
  return IAM.listSSHPublicKeys({
    UserName: userName
  }).promise().then(function(data) {
    return Promise.all(data.SSHPublicKeys.filter(key => key.Status == 'Active')
      .map(key => {
        return IAM.getSSHPublicKey({
            Encoding: 'SSH',
            UserName: key.UserName,
            SSHPublicKeyId: key.SSHPublicKeyId
          }).promise()
          .then(function(data) {
            return 'environment="SSH_USER=' + key.UserName + '"' +
              ' ' + data.SSHPublicKey.SSHPublicKeyBody + ' ' + key.UserName;
          });
      }));
  });
};

let getAuthorizedKeysForGroup = (groupName) => {
  return IAM.getGroup({
    GroupName: groupName
  }).promise().then(function(data) {
    return Promise.all(data.Users.map(user => {
        return getAuthorizedKeysForUser(user.UserName);
      }))
      .then(userKeys => [].concat(...userKeys)); // flatten user keys
  });
};

let getAuthorizedKeysForPrincipal = (principal) => {
  let [principalType, principalName] = principal.split('/');
  switch (principalType) {
    case 'users':
      return getAuthorizedKeysForUser(principalName);
    case 'groups':
      return getAuthorizedKeysForGroup(principalName);
    default:
      throw 'Unsuported principal type' + principalType;
  }
};

let deletePricicipalsKeys = (principalList) => {
  console.log("Delete authorized keys for principal: " + principalList);
  if (principalList.length) {
    return S3.deleteObjects({
      Bucket: s3Bucket,
      Delete: {
        Objects: principalList.map(principal => ({
          Key: principal + '/authorized_keys'
        }))
      }
    });
  }
  return [];
};

let uploadPrincipalKeys = (principal, authorizedKeys) => {
  console.log("Upload authorized keys for principal: " + principal);
  return S3.putObject({
    Bucket: s3Bucket,
    Key: principal + '/authorized_keys',
    Body: authorizedKeys.join('\n') + '\n'
  }).promise();
};

let listPricipalFromS3 = () => {
  let userPricipalListPromise = S3.listObjects({
      Bucket: s3Bucket,
      Delimiter: '/',
      Prefix: 'users/'
    }).promise().then(data => {
      return data.CommonPrefixes.map(prefix => prefix.Prefix.replace(new RegExp(data.Delimiter + '$'), ''));
    });

  let groupPricipalListPromise = S3.listObjects({
    Bucket: s3Bucket,
    Delimiter: '/',
    Prefix: 'groups/'
  }).promise().then(data => {
    return data.CommonPrefixes.map(prefix => prefix.Prefix.replace(new RegExp(data.Delimiter + '$'), ''));
  });

  return Promise.all([userPricipalListPromise, groupPricipalListPromise])
    .then(resultList => [].concat(...resultList));
};


let listPricipalFromIAM = () => {
  let userPricipalListPromise = IAM.listUsers({}).promise().then(data => {
    return data.Users.map(user => 'users/' + user.UserName);
  });

  let groupPricipalListPromise = IAM.listGroups({}).promise().then(data => {
    return data.Groups.map(group => 'groups/' + group.GroupName);
  });

  return Promise.all([userPricipalListPromise, groupPricipalListPromise])
    .then(resultList => [].concat(...resultList));
};


module.exports.syncSSHKeysToS3 = (event, context, callback) => {
  let pricipalListS3Promise = listPricipalFromS3();
  let pricipalListIAMPromise = listPricipalFromIAM();

  // Delete principals in S3 not present in IAM
  let deleteUserKeysPromise = Promise.all([pricipalListS3Promise, pricipalListIAMPromise])
    .then(resultList => {
      let [principalListS3, principalListIAM] = resultList;
      return principalListS3.filter(principal => !principalListIAM.includes(principal));
    })
    .then(principalListToDelete => deletePricicipalsKeys(principalListToDelete));

  // Update pricipals authorized keys in S3 from IAM principals keys
  let uploadUserKeysPromise = pricipalListIAMPromise.then(function(principals) {
    return Promise.all(principals.map(principal => {
      return getAuthorizedKeysForPrincipal(principal).then(authorizedKeys => {
        return uploadPrincipalKeys(principal, authorizedKeys);
      });
    }));
  });

  // wait for sync is completed
  Promise.all([deleteUserKeysPromise, uploadUserKeysPromise])
    .then(data => callback(null, 'done!'))
    .catch(err => callback(err, err.stack));
};