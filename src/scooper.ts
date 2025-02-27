import {
  Connection,
  GetProgramAccountsFilter,
  VersionedTransaction,
  sendAndConfirmRawTransaction,
  PublicKey,
  TransactionMessage,
  TransactionInstruction,
  AddressLookupTableAccount
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createHarvestWithheldTokensToMintInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync
} from '@solana/spl-token';
import { WalletContextState } from '@solana/wallet-adapter-react';
import { Buffer } from 'buffer';
import {
  SwapInstructionsResponse,
  DefaultApi,
  QuoteResponse
} from '@jup-ag/api';

import {
  QuoteGetRequest,
  SwapPostRequest,
  createJupiterApiClient
} from '@jup-ag/api';
import { usePercentageValue } from './PercentageContext';

interface TokenInfo {
  address: string;
  chainId: number;
  decimals: number;
  name: string;
  symbol: string;
  logoURI: string;
  tags: string[];
  strict?: boolean;
}

interface Asset {
  asset: TokenBalance;
  quote?: QuoteResponse;
  swap?: SwapInstructionsResponse;
  checked?: boolean;
}

interface TokenBalance {
  token: TokenInfo;
  balance: bigint;
  programId: PublicKey;
  ataId: PublicKey;
}

interface PercentageContextProps {
  percentage: number;
  bigIntPercentage: bigint;
  setPercentage: (value: number) => void;
}

const BONK_TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const liquidStableTokens = ["mSOL", "USDC", "JitoSOL", "bSOL", "mrgnLST", "jSOL", "stSOL", "scnSOL", "LST"];
const forbiddenTokens = ["USDT"].concat(liquidStableTokens);

// Removed distributionTargets since no fee will be distributed
/*
const distributionTargets: [PublicKey, number][] = [
  [
    getAssociatedTokenAddressSync(
      new PublicKey(BONK_TOKEN_MINT),
      new PublicKey("2Vi8WzFHAAVNjtAquByvdzzpw8p4MuXhkQyBxs4qSVxw") // bonk fees
    ),
    0.22999999999999998 // 0.22999999999999998%
  ]
];
*/

/**
 * Get the total fee amount
 */
function getTotalFee(): number {
  // Return 0 since no fee is being applied
  return 0.0;
}


/**
 * Returns the expected outputs of burning an asset
 *
 * @param asset The asset to calculate returns for
 * @returns Object containing information about return/fees
 */
function getAssetBurnReturn(asset: Asset): {burnAmount: bigint, bonkAmount: bigint, lamportsAmount: bigint, feeAmount: bigint} {
  var burnAmount: bigint;
  var bonkAmount: bigint;
  var lamportsAmount: bigint;

  if (asset.quote) {
    burnAmount = asset.asset.balance - BigInt(asset.quote.inAmount);
    bonkAmount = BigInt(asset.quote.outAmount);
    if (asset.asset.programId == TOKEN_2022_PROGRAM_ID) {
      lamportsAmount = BigInt(0);
    } else {
      lamportsAmount = BigInt(2400000);
    }
  } else {
    burnAmount = asset.asset.balance;
    bonkAmount = BigInt(0);
    lamportsAmount = BigInt(2400000);
  }

  // Remove fee calculation
  // let totalFee = getTotalFee();
  // let feeAmount = bonkAmount / BigInt(Math.floor(100 / totalFee));
  // bonkAmount -= feeAmount;

  // Set feeAmount to 0 since we're removing the fee
  let feeAmount = BigInt(0);

  return {
    burnAmount: burnAmount,
    bonkAmount: bonkAmount,
    lamportsAmount: lamportsAmount,
    feeAmount: feeAmount
  }
}

/**
 * Gets token accounts including standard and token22 accounts
 *
 * Returns a list of all token accounts which match a "known" token in tokenList
 *
 * @param wallet - The users public key as a string
 * @param connection - The connection to use
 * @param tokenList - List of all known tokens
 * @returns A List of TokenBalances containing information about tokens held by the user and their balances
 */
async function getTokenAccounts(
  wallet: string,
  solanaConnection: Connection,
  tokenList: { [id: string]: TokenInfo }
): Promise<TokenBalance[]> {
  const filters: GetProgramAccountsFilter[] = [
    {
      dataSize: 165
    },
    {
      memcmp: {
        offset: 32,
        bytes: wallet
      }
    }
  ];
  const accountsOld = await solanaConnection.getParsedProgramAccounts(
    TOKEN_PROGRAM_ID,
    { filters: filters }
  );
  const filtersNew: GetProgramAccountsFilter[] = [
    {
      dataSize: 182
    },
    {
      memcmp: {
        offset: 32,
        bytes: wallet
      }
    }
  ];
  const accountsNew = await solanaConnection.getParsedProgramAccounts(
    TOKEN_2022_PROGRAM_ID,
    { filters: filtersNew }
  );

  console.log(
    `Found ${accountsNew.length} token account(s) for wallet ${wallet}.`
  );
  var tokens: TokenBalance[] = [];

  accountsOld.forEach((account, i) => {
    console.log(account);
    const parsedAccountInfo: any = account.account.data;
    const mintAddress: string = parsedAccountInfo['parsed']['info']['mint'];
    if (tokenList[mintAddress] && !forbiddenTokens.includes(tokenList[mintAddress].symbol) ) {
      tokens.push({
        token: tokenList[mintAddress],
        balance: BigInt(
          parsedAccountInfo['parsed']['info']['tokenAmount']['amount']
        ),
        programId: TOKEN_PROGRAM_ID,
        ataId: account.pubkey
      });
    }
  });
  accountsNew.forEach((account, i) => {
    console.log(account);
    const parsedAccountInfo: any = account.account.data;
    const mintAddress: string = parsedAccountInfo['parsed']['info']['mint'];
    if (tokenList[mintAddress]) {
      tokens.push({
        token: tokenList[mintAddress],
        balance: BigInt(
          parsedAccountInfo['parsed']['info']['tokenAmount']['amount']
        ),
        programId: TOKEN_2022_PROGRAM_ID,
        ataId: account.pubkey
      });
    }
  });

  return tokens;
}

const deserializeInstruction = (instruction: any) => {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((key: any) => ({
      pubkey: new PublicKey(key.pubkey),
      isSigner: key.isSigner,
      isWritable: key.isWritable
    })),
    data: Buffer.from(instruction.data, 'base64')
  });
};

async function getAddressLookupTableAccounts(
  connection: Connection,
  keys: string[]
): Promise<AddressLookupTableAccount[]> {
  const addressLookupTableAccountInfos =
    await connection.getMultipleAccountsInfo(
      keys.map((key) => new PublicKey(key))
    );

  return addressLookupTableAccountInfos.reduce((acc, accountInfo, index) => {
    const addressLookupTableAddress = keys[index];
    if (accountInfo) {
      const addressLookupTableAccount = new AddressLookupTableAccount({
        key: new PublicKey(addressLookupTableAddress),
        state: AddressLookupTableAccount.deserialize(accountInfo.data)
      });
      acc.push(addressLookupTableAccount);
    }

    return acc;
  }, new Array<AddressLookupTableAccount>());
}

/**
 * Builds a transaction which includes:
 *  Swap instruction + supporting instructions if a swap is present
 *  Burn Tokens/Harvest witheld to mint if a swap is using token 2022 standard
 *  Close account instruction
 *
 * Note that this function can be slow as it must `getAddressLookupTableAccounts` which involves fetching on chain data
 *
 * @param wallet - The users public key as a string
 * @param connection - The connection to use
 * @param blockhash - Recent blockhash to use in making transaction
 * @param asset - The asset to build a transaction for
 * @returns Transaction if there are any instructions to execute, else null
 */
async function buildBurnTransaction(
  wallet: WalletContextState,
  connection: Connection,
  blockhash: string,
  asset: Asset,
  percentage = usePercentageValue,
): Promise<VersionedTransaction | null> {
  if (asset.checked && wallet.publicKey) {
    var instructions: TransactionInstruction[] = [];
    var lookup = undefined;
    if (asset.swap) {
      console.log(asset.swap);
      asset.swap.computeBudgetInstructions.forEach((computeIx) => {
        if (!asset.swap) {
          return;
        }
        instructions.push(deserializeInstruction(computeIx));
      });

      asset.swap.setupInstructions.forEach((setupIx) => {
        if (!asset.swap) {
          return;
        }
        instructions.push(deserializeInstruction(setupIx));
      });

      instructions.push(deserializeInstruction(asset.swap.swapInstruction));

      const addressLookupTableAccounts: AddressLookupTableAccount[] = [];

      addressLookupTableAccounts.push(
        ...(await getAddressLookupTableAccounts(
          connection,
          asset.swap.addressLookupTableAddresses
        ))
      );
      lookup = addressLookupTableAccounts;
    }

    // Removed burn amount and burn instruction section

    // Removed harvest fees section

    // Removed close account section

    // Removed the fee distribution section since no fee will be applied
    /*
    distributionTargets.forEach(([target, sharePercent]) => {
      if (
        wallet.publicKey && asset.quote && 
        (BigInt(asset.quote.outAmount) / BigInt(Math.floor(100 / sharePercent))) > 0n
      ) {
        const transferInstruction = createTransferInstruction(
          getAssociatedTokenAddressSync(
            new PublicKey(BONK_TOKEN_MINT),
            wallet.publicKey
          ),
          target,
          wallet.publicKey,
          (BigInt(asset.quote.outAmount) / BigInt(Math.floor(100 / sharePercent)))
        );
        instructions.push(transferInstruction);
      }
    });
    */

    console.log(instructions);
    if (instructions.length > 0) {
      const message = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: instructions
      }).compileToV0Message(lookup);
      const tx = new VersionedTransaction(message);
      console.log('Created transaction');
      console.log(tx);
      return tx;
    }
  }
  return null;
}



/**
 * Sweeps a set of assets, signing and executing a set of previously determined transactions to swap them into the target currency
 *
 * @param wallet - The users public key as a string
 * @param connection - The connection to use
 * @param assets - List of the assets to be swept
 * @param transactionStateCallback - Callback to notify as a transactions state updates
 * @param transactionIdCallback - Callback to notify when a transaction has an ID
 * @param transactionIdCallback - Callback to notify on errors
 * @returns void Promise, promise returns when all actions complete
 */
async function sweepTokens(
  wallet: WalletContextState,
  connection: Connection,
  assets: Asset[],
  transactionStateCallback: (id: string, state: string) => void,
  transactionIdCallback: (id: string, txid: string) => void,
  errorCallback: (id: string, error: any) => void
): Promise<void> {
  const transactions: [string, VersionedTransaction][] = [];
  const blockhash = await (await connection.getLatestBlockhash()).blockhash;
  
  await Promise.all(
    assets.map(async (asset) => {
      const tx = await buildBurnTransaction(
        wallet,
        connection,
        blockhash,
        asset
      );
      if (tx) {
        transactions.push([asset.asset.token.address, tx]);
      }
    })
  );

  console.log('Transactions');
  console.log(transactions);

  if (wallet.signAllTransactions) {
    const signedTransactions = await wallet.signAllTransactions(
      transactions.map(([id, transaction]) => transaction)
    );

    console.log('Signed transactions:');
    console.log(signedTransactions);
    console.log(transactions);

    await Promise.all(
      signedTransactions.map(async (transaction, i) => {
        const assetId = transactions[i][0];
        transactionStateCallback(assetId, 'Swapping pro rata');

        try {
          const result = await sendAndConfirmRawTransaction(
            connection,
            Buffer.from(transaction.serialize()),
            {}
          );
          console.log('Transaction Success!');
          transactionStateCallback(assetId, 'Swapped');
          transactionIdCallback(assetId, result);
        } catch (err) {
          console.log('Transaction failed!');
          console.log(err);
          transactionStateCallback(assetId, 'Error');
          errorCallback(assetId, err);
        }
      })
    );
  }
}



/**
 * Sweeps a set of assets, signing and executing a set of previously determined transactions to swap them into the target currency
 *
 * @param wallet - The users public key as a string
 * @param connection - The connection to use
 * @param assets - List of the assets to be swept
 * @param transactionStateCallback - Callback to notify as a transactions state updates
 * @param transactionIdCallback - Callback to notify when a transaction has an ID
 * @param transactionIdCallback - Callback to notify on errors
 * @returns void Promise, promise returns when all actions complete
 */
async function sweepSwapTokens(
  wallet: WalletContextState,
  connection: Connection,
  assets: Asset[],
  percentage: Number,
  transactionStateCallback: (id: string, state: string) => void,
  transactionIdCallback: (id: string, txid: string) => void,
  errorCallback: (id: string, error: any) => void
): Promise<void> {
  const transactions: [string, VersionedTransaction][] = [];
  const blockhash = await (await connection.getLatestBlockhash()).blockhash;

  await Promise.all(
    assets.map(async (asset) => {
      const tx = await buildBurnTransaction(
        wallet,
        connection,
        blockhash,
        asset
      );
      if (tx) {
        transactions.push([asset.asset.token.address, tx]);
      }
    })
  );

  console.log('Transactions');
  console.log(transactions);

  if (wallet.signAllTransactions) {
    const signedTransactions = await wallet.signAllTransactions(
      transactions.map(([id, transaction]) => transaction)
    );

    console.log('Signed transactions:');
    console.log(signedTransactions);
    console.log(transactions);

    await Promise.all(
      signedTransactions.map(async (transaction, i) => {
        const assetId = transactions[i][0];
        transactionStateCallback(assetId, 'Swapping pro rata');

        try {
          const result = await sendAndConfirmRawTransaction(
            connection,
            Buffer.from(transaction.serialize()),
            {}
          );
          console.log('Transaction Success!');
          transactionStateCallback(assetId, 'Swapped');
          transactionIdCallback(assetId, result);
        } catch (err) {
          console.log('Transaction failed!');
          console.log(err);
          transactionStateCallback(assetId, 'Error');
          errorCallback(assetId, err);
        }
      })
    );
  }
}


/**
 * Get quotes and transaction data to swap input currencies into output currency
 *
 * @param connection - The connection to use
 * @param tokens - The tokens to seek quotes for
 * @param outputMint - The Mint for the output currency
 * @param walletAddress - Users wallet address
 * @param quoteApi - Instance of Jupiter API
 * @param foundAssetCallback - Callback to notify when an asset held by the user has been found
 * @param foundQuoteCallback - Callback to notify when a quote for the user asset has been found
 * @param foundSwapCallback - Callback to notify when the swap transaction details for the user asset has been found
 * @param errorCallback - Callback to notify on errors
 * @returns void Promise, promise returns when all actions complete
 */
async function findQuotes(
  connection: Connection,
  tokens: { [id: string]: TokenInfo },
  outputMint: string,
  walletAddress: string,
  quoteApi: DefaultApi,
  foundAssetCallback: (id: string, asset: TokenBalance) => void,
  foundQuoteCallback: (id: string, quote: QuoteResponse) => void,
  foundSwapCallback: (id: string, swap: SwapInstructionsResponse) => void,
  errorCallback: (id: string, err: string) => void
): Promise<void>
 {
  const ogassets = await getTokenAccounts(walletAddress, connection, tokens);

  await Promise.all(
    ogassets.map(async (asset) => {
      console.log('Found asset');
      console.log(asset);
      foundAssetCallback(asset.token.address, asset);

      const adjustedAmount = Number(asset.balance);

      const quoteRequest: QuoteGetRequest = {
        inputMint: asset.token.address,
        outputMint: outputMint,
        amount: adjustedAmount,
        slippageBps: 1500
      };

      console.log("quote request log;", quoteRequest);
      console.log(`Adjusted Amount for ${asset.token}: is ${adjustedAmount}`);

      try {
        const ogquote = await quoteApi.quoteGet(quoteRequest);
        foundQuoteCallback(asset.token.address, ogquote);

        const ogrq: SwapPostRequest = {
          swapRequest: {
            userPublicKey: walletAddress,
            quoteResponse: ogquote
          }
        };

        try {
          const ogswap = await quoteApi.swapInstructionsPost(ogrq);
          foundSwapCallback(asset.token.address, ogswap);
        } catch (swapErr) {
          console.log(`Failed to get swap for ${asset.token.symbol}`);
          console.log(swapErr);
          errorCallback(asset.token.address, "Couldn't get swap transaction");
        }
      } catch (quoteErr) {
        console.log(`Failed to get quote for ${asset.token.symbol}`);
        console.log(quoteErr);
        errorCallback(asset.token.address, "Couldn't get quote");
      }
    })
  );
}

/**
 * Get quotes and transaction data to swap input currencies into output currency
 *
 * @param connection - The connection to use
 * @param tokens - The tokens to seek quotes for
 * @param outputMint - The Mint for the output currency
 * @param walletAddress - Users wallet address
 * @param quoteApi - Instance of Jupiter API
 * @param usePercentageValue - User-inputted percentage to calculate quote amount
 * @param foundAssetCallback - Callback to notify when an asset held by the user has been found
 * @param foundQuoteCallback - Callback to notify when a quote for the user asset has been found
 * @param foundSwapCallback - Callback to notify when the swap transaction details for the user asset has been found
 * @param errorCallback - Callback to notify on errors
 * @returns void Promise, promise returns when all actions complete
 */
async function findSwapQuotes(
  connection: Connection,
  tokens: { [id: string]: TokenInfo },
  outputMint: string,
  walletAddress: string,
  quoteApi: DefaultApi,
  usePercentageValue: number,
  foundAssetCallback: (id: string, asset: TokenBalance) => void,
  foundQuoteCallback: (id: string, quote: QuoteResponse) => void,
  foundSwapCallback: (id: string, swap: SwapInstructionsResponse) => void,
  errorCallback: (id: string, err: string) => void
): Promise<void> {
  const assets = await getTokenAccounts(walletAddress, connection, tokens);

  await Promise.all(
    assets.map(async (asset) => {
      console.log('Found asset');
      console.log(asset);
      foundAssetCallback(asset.token.address, asset);

      const adjustedAmount = Number(asset.balance) * usePercentageValue; // Use the provided percentage value directly

      const quoteRequest: QuoteGetRequest = {
        inputMint: asset.token.address,
        outputMint: outputMint,
        amount: adjustedAmount,
        slippageBps: 1500
      };

      console.log("quote request log;", quoteRequest);
      console.log(`Adjusted Amount for ${asset.token}: is ${adjustedAmount}`);

      try {
        const quote = await quoteApi.quoteGet(quoteRequest);
        foundQuoteCallback(asset.token.address, quote);

        const rq: SwapPostRequest = {
          swapRequest: {
            userPublicKey: walletAddress,
            quoteResponse: quote
          }
        };

        console.log('Percentage from usePercentageValue:', usePercentageValue);

        try {
          const swap = await quoteApi.swapInstructionsPost(rq);
          foundSwapCallback(asset.token.address, swap);
        } catch (swapErr) {
          console.log(`Failed to get swap for ${asset.token.symbol}`);
          console.log(swapErr);
          errorCallback(asset.token.address, "Couldn't get swap transaction");
        }
      } catch (quoteErr) {
        console.log(`Failed to get quote for ${asset.token.symbol}`);
        console.log(quoteErr);
        errorCallback(asset.token.address, "Couldn't get quote");
      }
    })
  );
}


/**
 * Load Jupyter API and tokens
 *
 * @returns [instance of Jupiter API, map of known token types by mint address]
 */
async function loadJupyterApi(): Promise<
  [DefaultApi, { [id: string]: TokenInfo }]
> {
  let quoteApi = createJupiterApiClient();
  const allTokens = await fetch('https://token.jup.ag/all');
  const allList = await allTokens.json();
  const tokenMap: { [id: string]: TokenInfo } = {};
  allList.forEach((token: TokenInfo) => {
    tokenMap[token.address] = token;
  });

  const strictTokens = await fetch('https://token.jup.ag/strict');
  const strictList = await strictTokens.json();
  strictList.forEach((token: TokenInfo) => {
    tokenMap[token.address].strict = true;
  });
  return [quoteApi, tokenMap];
}


/**
 * Load Jupyter API and tokens
 *
 * @returns [instance of Jupiter API, map of known token types by mint address]
 */
async function loadogJupyterApi(): Promise<
  [DefaultApi, { [id: string]: TokenInfo }]
> {
  let quoteApi = createJupiterApiClient();
  const ogTokens = await fetch('https://token.jup.ag/all');
  const ogList = await ogTokens.json();
  const ogtokenMap: { [id: string]: TokenInfo } = {};
  ogList.forEach((token: TokenInfo) => {
    ogtokenMap[token.address] = token;
  });

  const strictogTokens = await fetch('https://token.jup.ag/strict');
  const strictogList = await strictogTokens.json();
  strictogList.forEach((token: TokenInfo) => {
    ogtokenMap[token.address].strict = true;
  });
  return [quoteApi, ogtokenMap];
}

export { getTokenAccounts, getAssetBurnReturn, sweepTokens, sweepSwapTokens, findQuotes, findSwapQuotes, loadJupyterApi, getTotalFee, BONK_TOKEN_MINT };

export type { TokenInfo, TokenBalance };
