const ethers = require('ethers');
const fetch = require('node-fetch');
const pThrottle = require('p-throttle');

const abi = require('./TimelockController.abi.json');

// Constants
const supportedNetworks = ['mainnet', 'bnb', 'binance', 'matic'];
const executorRoleId = `0xd8aa0f3194971a2a116679f7c2090f6939c8d4e01a2a8d7e41d55e5351469e63`;
const proposerRoleId = `0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1`;
const adminRoleId = `0x5f58e3a2316349923ce3780f8d587db2d72378aed66a8261c916544fa6846ca5`;
const roleIds = { [executorRoleId]: 'executor', [proposerRoleId]: 'proposer', [adminRoleId]: 'timelock_admin' };

// We extend ethers.js etherscan provider to support bsc and matic
class ExtendedEtherscanProvider extends ethers.providers.EtherscanProvider {
  constructor(network, apiKey) {
    super(network, apiKey);
  }

  getBaseUrl() {
    return getEtherscanUrl(this.network.name) || super.getBaseUrl();
  }
}

function getEtherscanUrl(network) {
  switch(network) {
    case "mainnet":
        return "https://api.etherscan.io";
    case "bsc":
    case "binance":
    case "bnb":
        return "https://api.bscscan.com";
    case "matic":
        return "https://api.polygonscan.com";
  }
}

// Hardcoded Etherscan API keys for ease of use of this script.
// We will be revoking them after the migration process ends.
// If necessary, you can provide a custom API key through the
// environment variable ETHERSCAN_API_KEY.
function getApiKey(network) {
  if (process.env.ETHERSCAN_API_KEY) {
    return process.env.ETHERSCAN_API_KEY;
  }

  switch(network) {
    case "mainnet":
        return "A8FAZDSPFS9USX5WEA8TAMP2YMKBMBPKKX";
    case "bsc":
    case "binance":
    case "bnb":
        return "BE21V8UI9XQGF2YSNIFTBCWD9571U6KJRP";
    case "matic":
    case "polygon":
        return "1BY8GDEGTWV55F94J43Y79JG3JK8Y5AVSF";
  }
}

// Returns an ethers js provider backed by etherscan
async function getProvider(network) {
  return new ExtendedEtherscanProvider(network, getApiKey(network));
}

// Validates and returns a connected timelock contract at the specified address and network
async function getTimelock(network, address) {
  const contract = new ethers.Contract(address, abi, await getProvider(network));
  const adminRole = await contract.TIMELOCK_ADMIN_ROLE().catch(() => undefined);
  const expected = adminRoleId;
  if (adminRole !== expected) {
    throw new Error(`Contract at ${address} does not appear to be a TimelockController instance`);
  }
  contract.network = network;
  return contract;
}

// Returns all roles on the contract by querying etherscan's logs API
async function getRoles(tc) {
  const res = {};

  for (const [id, role] of Object.entries(roleIds)) {
    const granted = await queryFilter(tc, 'RoleGranted', id);
    const revoked = await queryFilter(tc, 'RoleRevoked', id);
    res[role] = processRoleEvents(granted, revoked);
  }

  return res;
}

function processRoleEvents(granted, revoked) {
  const events = [...granted, ...revoked].sort(compareTxs);
  const accounts = new Set();
  for (const e of events) {
    if (e.event === 'RoleGranted') {
      accounts.add(e.args.account);
    } else if (e.event === 'RoleRevoked') {
      accounts.delete(e.args.account);
    }
  }
  return [...accounts];
}

function compareTxs(tx1, tx2) {
  const block1 = parseInt(tx1.blockNumber);
  const idx1 = parseInt(tx1.transactionIndex);
  const logIdx1 = parseInt(tx1.logIndex);

  const block2 = parseInt(tx2.blockNumber);
  const idx2 = parseInt(tx2.transactionIndex);
  const logIdx2 = parseInt(tx2.logIndex);

  return (block1 - block2) || (idx1 - idx2) || (logIdx1 - logIdx2);
}

// Queries etherscan's logs API
async function queryFilter(tc, event, ...topics) {
  const url = new URL(`${getEtherscanUrl(tc.network)}/api?apikey=${getApiKey(tc.network)}`);

  const params = {
    module: 'logs',
    action: 'getLogs',
    fromBlock: '0',
    toBlock: 'latest',
  };

  const filter = tc.filters[event](...topics);

  if (filter.address) {
    params.address = filter.address;
  }

  for (let i = 0; i < filter.topics.length; i++) {
    const topic = filter.topics[i];
    if (typeof topic !== 'string') {
      throw new Error('non string topic not supported');
    }
    params['topic' + i] = topic;
  }

  const data = await etherscanGet(url, params);

  if (data.message === 'No records found') {
    return [];
  }

  if (data.status !== '1') {
    throw new Error(
      `etherscan api error (status ${data.status}, msg: ${data.message})\n`
      + url.toString()
    );
  }

  return data.result.map(r => Object.assign(r, {
    event,
    args: tc.interface.decodeEventLog(event, r.data, r.topics),
  }));
}

// Queries etherscan's API throttling as needed
const etherscanGet = pThrottle({ limit: 5, interval: 1000 })(
  async (url, params) => {
    for (const [key, val] of Object.entries(params)) {
      url.searchParams.set(key, val);
    }

    const res = await fetch(url);
    return res.json();
  }
);

// Prints the accounts with roles on a given timelock
async function viewRoles(timelock, roles) {
  console.log(`Roles on ${timelock.address}:`);
  for (const key of Object.keys(roles)) {
    console.log(`${key}s:`);
    if (!roles[key]) console.log(` none found`);
    else console.log(roles[key].map(r => `- ${r}`).join('\n'));
  }
}

// Creates and validates the list of executors to remove in a `revoke` action
// Uses `rawToRemove` as a comma separated list, or picks all executors who are not proposers
// Will validate that all addresses provided are indeed executors
async function getExecutorsToRemove(timelock, roles, rawToRemove) {
  if (rawToRemove) {
    const toRemove = rawToRemove.split(',');
    for (const addr of toRemove) {
      if (!ethers.utils.isAddress(addr)) {
        throw new Error(`Invalid address to remove: ${addr}`);
      } else if (!(await timelock.hasRole(executorRoleId, addr))) {
        throw new Error(`Address ${addr} is not an executor of the timelock`);
      }
    }
    return toRemove;
  } else {
    const toRemove = roles.executor.filter(e => !roles.proposer.includes(e));
    if (toRemove.length === 0) {
      console.log(`No executors found to remove by default.`);
      return;
    }
    return toRemove;
  }
}

// Crafts a scheduleBatch transaction to revoke a set of executors from the timelock
async function revokeExecutors(timelock, roles, rawToRemove) {
  const toRemove = await getExecutorsToRemove(timelock, roles, rawToRemove);
  const minDelay = await timelock.getMinDelay();

  if (toRemove.length === 0) {
    console.log(`No executors found to remove.`);
    return;
  }

  if (roles.executor.length === toRemove.length) {
    throw new Error(`Refusing to remove all executors from the timelock since this may brick the contract`);
  }

  if (!(await timelock.hasRole(adminRoleId, timelock.address))) {
    throw new Error(`Timelock is not self-governed`);
  }

  const targets = toRemove.map(e => timelock.address);
  const values = toRemove.map(e => ethers.BigNumber.from(0));
  const datas = toRemove.map(e => timelock.interface.encodeFunctionData('revokeRole', [executorRoleId, e]));
  const predecessor = ethers.constants.HashZero;
  const salt = ethers.constants.HashZero;
  const delay = minDelay;
  
  const scheduleBatchData = timelock.interface.encodeFunctionData('scheduleBatch', [targets, values, datas, predecessor, salt, delay]);
  const executeBatchData = timelock.interface.encodeFunctionData('executeBatch', [targets, values, datas, predecessor, salt]);

  console.log([
    `To remove executors:`,
    ...toRemove.map(r => ` ${r}`),
    ``,
    `Schedule the following batch proposal by calling scheduleBatch on your timelock with the parameters:`,
    ``,
    ` targets=${targets}`,
    ` values=${values}`,
    ` datas=${datas}`,
    ` predecessor=${predecessor}`,
    ` salt=${salt}`,
    ` delay=${delay}`,
    ``,
    `which is the same as sending a transaction with the following data:`,
    ``,
    ` ${scheduleBatchData}`,
    `After the delay of ${delay.toString()} seconds, you can then call executeBatch with the same parameters as above, or using the following tx data:`,
    ``,
    ` ${executeBatchData}`,
  ].join('\n'));

  return { scheduleBatchData, executeBatchData };
}

function printUsage() {
  console.log(`Usage: node roles.js [action] [network] [timelock-address] [comma-separated-executors-to-revoke]`);
  console.log(`Where:`);
  console.log(` action: view,revoke`)
  console.log(` network: mainnet,bnb,matic`)
  process.exit(1);
}

// Main entrypoint
async function main() {
  const action = process.argv[2];
  const network = process.argv[3];
  const address = process.argv[4];
  if (!action || !address || !ethers.utils.isAddress(address)) return printUsage();
  if (!network || !supportedNetworks.includes(network.toLowerCase())) return printUsage();
  
  const timelock = await getTimelock(network, address);
  const roles = await getRoles(timelock);

  switch (action) {
    case 'view': return await viewRoles(timelock, roles);
    case 'revoke': return await revokeExecutors(timelock, roles, process.argv[5]);
    default: return printUsage();
  }
}

// Exported for unit testing
module.exports = { revokeExecutors, viewRoles, processRoleEvents, executorRoleId, proposerRoleId, adminRoleId }

// Run!
if (module === require.main) {
  main().catch(console.error);
}
