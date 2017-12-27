# AWS IAM managed EC2 SSH access <img src="docs/aws-icon.png" width="64"/>

This approach will sync public ssh keys for user and groups from IAM account to an S3 bucket as authorized_keys files.
On the ssh daemon side AuthorizedKeysCommand is used to request authorized keys from S3 bucket on demand on ssh connection establishment.
So you can manage all ssh key access to your instances via IAM.

<img src="docs/aws-iam-icon.png" height="128"/><img src="docs/arrow-right.png" height="128"/><img src="docs/aws-lambda-icon.png" width="128"/><img src="docs/arrow-right.png" height="128"/><img src="docs/aws-s3-icon.png" height="128"/><img src="docs/arrow-right.png" height="128"/><img src="docs/aws-ec2-icon.png" height="128"/>

## Setup AWS IAM Account

### Preparation

- Install [Serverless framework](https://serverless.com/framework/docs/getting-started/)
- Adjust S3 bucketname `<S3Bucket>` within serverless.yml
- Create S3 Bucket

  - Bucket Policy - adjust `<AccountId>` and `<S3Bucket>`

    ```json
    {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {
                    "AWS": [
                      "arn:aws:iam::<AccountId_1>:root",
                      "arn:aws:iam::<AccountId_2>:root",
                      "arn:aws:iam::<AccountId_3>:root",
                    ]
                },
                "Action": [
                    "s3:ListBucket",
                    "s3:GetObject"
                ],
                "Resource": [
                    "arn:aws:s3:::<S3Bucket>",
                    "arn:aws:s3:::<S3Bucket>/*"
                ]
            }
        ]
    }
    ```

### Deploy

- Deploy Lambda Function to Sync SSH Keys from IAM to S3

  - `serverless deploy -v`

## Setup AWS Client Account

### Preparation

- Create Role Policy in Sub Account - adjust `<S3Bucket>`

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:ListBucket",
                "s3:GetObject"
            ],
            "Resource": [
               "arn:aws:s3:::<S3Bucket>",
               "arn:aws:s3:::<S3Bucket>/*"
            ]
        }
    ]
  }
  ```

- Attach policy to EC2 roles who should be able to access public ssh keys from IAM account

## Setup EC2 Instance

- Set following script as [Instance Userdata](http://docs.aws.amazon.com/AWSEC2/latest/UserGuide/user-data.html)

  - Adjust `IAM_BUCKET='<S3Bucket>'` and `IAM_PRINCIPALS=<IAMPrincipals>`

    - `IAM_PRINCIPALS` is a comma separated list of principals in the form **groups/[GroupName]** and **users/[UserName]**
    - **Dynamic principals**

      - Get Principals from AWS Systems Manager Parameter Store

        ```shell
        IAM_PRINCIPALS=$(aws ssm get-parameter --name "<App>-iam-principals" --query 'Parameter.Value' --output text)
        ```

  - Userdata Script

    ```shell
    #!/bin/bash

    # create script to return authorized ssh keys
    cat > /usr/local/bin/authorized_keys.sh <<'EOF'
    #!/bin/bash
    export AWS_DEFAULT_REGION=eu-central-1

    IAM_BUCKET='<S3Bucket>'
    IAM_PRINCIPALS='<IAMPrincipals>'

    for iam_principal in ${IAM_PRINCIPALS//,/ } ; do 
      aws s3 cp s3://${IAM_BUCKET}/${iam_principal}/authorized_keys -
    done
    EOF
    chmod a+x /usr/local/bin/authorized_keys.sh

    # add ssh user access logging && separated history per ssh user
    cat > /home/ec2-user/.ssh/rc <<'EOF'
    #!/bin/bash
    export SSH_USER=${SSH_USER:-'unknown'}
    logger -ip authpriv.notice -t sshd "Publickey owner is ${SSH_USER} for connection $(tmp=${SSH_CLIENT% *}; echo ${tmp// / port })"
    export HISTFILE="$HOME/.history_${SSH_USER}" && export HISTTIMEFORMAT='%F %T '
    EOF
    chmod a+x /home/ec2-user/.ssh/rc

    # adjust ssh daemon config
    cat >> /etc/ssh/sshd_config <<'EOF' 

    LogLevel                   VERBOSE
    PermitUserEnvironment      yes
    AuthorizedKeysCommand      /usr/local/bin/authorized_keys.sh
    AuthorizedKeysCommandUser  nobody
    EOF

    # restart ssh daemon
    service sshd restart
    ```
