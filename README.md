# Timelock role management script

This nodejs script allows to view the account assigned to each role in a `TimelockController` instance, and to prepare a batch action to revoke the `EXECUTOR` role to a subset of executors.

## Setup

1. Install [nodejs](https://nodejs.org/en/) (this script has been tested on node 12.x)
2. Change directory to where you have downloaded this script
3. Install dependencies with `npm install`

## View privileged accounts

To view all accounts with any rights on your Timelock, run the following command, replacing `ADDRESS` with the address of your timelock, and `NETWORK` with one of `mainnet`, `bsc`, or `matic`.

```
node roles.js view NETWORK ADDRESS
```

This will return the list of accounts with the `EXECUTOR`, `PROPOSER`, and `TIMELOCK_ADMIN` roles.

## Revoke executors by scheduling a proposal

To prepare a `scheduleBatch` transaction that revokes the `EXECUTOR` role from a set of accounts, run a command like the following with the executor accounts separated by a single comma, i.e. replacing each `EXECUTORn` by the address of the executor you want to remove:

```
node roles.js revoke NETWORK ADDRESS EXECUTOR1,EXECUTOR2,EXECUTOR3
```

> Note that you only need this if you have renounced `TIMELOCK_ADMIN` rights on your timelock. If your deployer account still has admin rights, you can use it to directly call `revokeRole` on the contract without going through a `scheduleBatch` operation.

This will output the parameters to `scheduleBatch` and `executeBatch` as you need to submit to your timelock controller in order to revoke access to the set of executors chosen. If you don't supply the `EXECUTOR` addresses, the command will default to crafting a proposal that revokes access to all executors who are not also proposers.

## Questions

Please contact us at security@openzeppelin.com if you have any questions.
