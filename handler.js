'use strict';

var Util = require('util');

let AWS = require('aws-sdk');
let S3 = new AWS.S3();
let IAM = new AWS.IAM();

// configuration
let s3Bucket = process.env.S3_BUCKET;
console.log('s3Bucket: ', s3Bucket);

let getAuthorizedKeysForUser = (userName) => {
  if (authorizedKeysForUserCache[userName]) {
    return Promise.resolve(authorizedKeysForUserCache[userName]);
  }
  return IAM.listSSHPublicKeys({
      UserName: userName
    }).promise()
    .then(data => {
      return Promise.all(data.SSHPublicKeys.filter(key => key.Status == 'Active')
        .map(key => {
          return IAM.getSSHPublicKey({
              Encoding: 'SSH',
              UserName: key.UserName,
              SSHPublicKeyId: key.SSHPublicKeyId
            }).promise()
            .then(data => {
              return Util.format('environment="SSH_KEY_OWNER=%s" %s %s', key.UserName, data.SSHPublicKey.SSHPublicKeyBody, key.UserName);
            });
        }));
    })
    .then(keys => {
      authorizedKeysForUserCache[userName] = keys;
      return keys;
    });
};

let getAuthorizedKeysForGroup = (groupName) => {
  return IAM.getGroup({
      GroupName: groupName
    }).promise()
    .then(data => Promise.all(data.Users
      .map(user => {
        return getAuthorizedKeysForUser(user.UserName);
      })))
    .then(userKeys => [].concat(...userKeys)); // flatten user keys;
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

let deletePricicipalKeys = (principal) => {
  console.log("Delete authorized keys for principal: " + principal);
  return S3.deleteObject({
    Bucket: s3Bucket,
    Key: principal + '/authorized_keys'
  }).promise();
};

let uploadPrincipalKeys = (principal, authorizedKeys) => {
  console.log("Upload authorized keys for principal: " + principal);
  return S3.putObject({
    Bucket: s3Bucket,
    Key: principal + '/authorized_keys',
    Body: authorizedKeys.join('\n') + '\n'
  }).promise();
};

let listPrincipalFromS3 = () => {
  let userPrincipalListPromise = S3.listObjects({
      Bucket: s3Bucket,
      Delimiter: '/',
      Prefix: 'users/'
    }).promise()
    .then(data => {
      return data.CommonPrefixes.map(prefix => prefix.Prefix.replace(new RegExp(data.Delimiter + '$'), ''));
    });

  let groupPrincipalListPromise = S3.listObjects({
      Bucket: s3Bucket,
      Delimiter: '/',
      Prefix: 'groups/'
    }).promise()
    .then(data => {
      return data.CommonPrefixes.map(prefix => prefix.Prefix.replace(new RegExp(data.Delimiter + '$'), ''));
    });

  return Promise.all([userPrincipalListPromise, groupPrincipalListPromise])
    .then(resultList => [].concat(...resultList));
};

let listPrincipalFromIAM = () => {
  let userPrincipalListPromise = IAM.listUsers({}).promise().then(data => {
    return data.Users.map(user => 'users/' + user.UserName);
  });

  let groupPrincipalListPromise = IAM.listGroups({}).promise().then(data => {
    return data.Groups.map(group => 'groups/' + group.GroupName);
  });

  return Promise.all([userPrincipalListPromise, groupPrincipalListPromise])
    .then(resultList => [].concat(...resultList));
};

module.exports.syncSSHKeysToS3 = (event, context, callback) => {
  let authorizedKeysForUserCache = {};
  let principalListS3Promise = listPrincipalFromS3();
  let principalListIAMPromise = listPrincipalFromIAM();
  let principalListS3DeletePromise = Promise.all([principalListS3Promise, principalListIAMPromise])
    .then(([principalListS3, principalListIAM]) => {
      return principalListS3.filter(principal => !principalListIAM.includes(principal));
    });

  // Delete principals in S3 not present in IAM
  let deleteUserKeysPromise = principalListS3DeletePromise
    .then(principals => {
      return Promise.all(principals.map(principal => {
        return deletePricicipalKeys(principal);
      }));
    });

  // Update principals authorized keys in S3 from IAM principals keys
  let uploadUserKeysPromise = principalListIAMPromise
    .then(principals => {
      return Promise.all(principals.map(principal => {
        return getAuthorizedKeysForPrincipal(principal)
          .then(authorizedKeys => {
            return uploadPrincipalKeys(principal, authorizedKeys);
          });
      }));
    });

  // wait for sync is completed
  Promise.all([deleteUserKeysPromise, uploadUserKeysPromise])
    .then(data => callback(null, 'done!'))
    .catch(err => callback(err, err.stack));
};
