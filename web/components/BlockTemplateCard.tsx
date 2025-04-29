'use client';

import React, { useMemo, useState, useEffect, useRef } from 'react';
import { StratumV1Data, CoinbaseOutput } from "@/lib/types";
import {
    formatNbits,
} from '@/utils/formatters';
import {
    computeCoinbaseOutputValue,
    computeCoinbaseOutputs,
    getTransaction,
    decodeCoinbaseScriptSigInfo,
    CoinbaseScriptSigInfo,
    getCoinbaseTxDetails,
    CoinbaseTxDetails,
    getFormattedCoinbaseAsciiTag
} from '@/utils/bitcoinUtils';
import MerkleTreeVisualization from './MerkleTreeVisualization';
import { SortedRow } from '@/types/tableTypes';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { getMerkleColor } from '@/utils/colorUtils';
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"

interface BlockTemplateCardProps {
  latestMessage?: StratumV1Data;
}

// Helper function to parse coinbase data, encapsulating the try/catch logic
// This is NOT memoized here, memoization will happen where it's called if needed based on cbRaw
const parseCoinbaseData = (cbRaw: string): { 
  scriptSigInfo: CoinbaseScriptSigInfo | null, 
  txDetails: CoinbaseTxDetails | null 
} => {
  let scriptSigInfo: CoinbaseScriptSigInfo | null = null;
  let txDetails: CoinbaseTxDetails | null = null;
  let scriptSigBuffer: Buffer | null = null;

  try {
    const tx = getTransaction(cbRaw);
    if (tx.ins && tx.ins.length > 0) {
      scriptSigBuffer = tx.ins[0].script;
      scriptSigInfo = decodeCoinbaseScriptSigInfo(scriptSigBuffer);
    } else {
      scriptSigInfo = { remainingScriptHex: '' }; // Handle case with no input script
    }
    // Get other tx details regardless of scriptSig parsing success
    txDetails = getCoinbaseTxDetails(cbRaw); 
    
  } catch (txError) {
    console.error("Error parsing coinbase tx info:", txError);
    // Fallback for scriptSig if buffer was available but parsing failed
    scriptSigInfo = { remainingScriptHex: scriptSigBuffer?.toString('hex') || '' }; 
    // Attempt to get other details even if script parsing failed
    try { 
      txDetails = getCoinbaseTxDetails(cbRaw);
    } catch (detailsError) {
        console.error("Error getting other coinbase details:", detailsError);
        txDetails = null; // Fallback for other details
    }
  }
  return { scriptSigInfo, txDetails };
};

// Custom hook to manage flash effect
const useFlashOnUpdate = (currentValue: unknown) => {
  const [isUpdated, setIsUpdated] = useState(false);
  const prevValueRef = useRef<unknown>(undefined);

  useEffect(() => {
    if (prevValueRef.current !== undefined && currentValue !== prevValueRef.current) {
      setIsUpdated(true);
      const timer = setTimeout(() => setIsUpdated(false), 1000);
      return () => clearTimeout(timer);
    } 
    prevValueRef.current = currentValue;
  }, [currentValue]);

  return isUpdated ? 'flash-update' : '';
};

// Modify CoinbaseOutputItem props
interface CoinbaseOutputItemProps {
  output: CoinbaseOutput;
  showRawData: boolean; // Added prop
}

const CoinbaseOutputItem: React.FC<CoinbaseOutputItemProps> = React.memo(({ output, showRawData }) => {
    // Call the hook correctly at the top level of this component
    const outputFlash = useFlashOnUpdate(JSON.stringify(output));

    return (
        <div className={`p-1.5 border rounded font-mono text-[11px] ${outputFlash}`}>
            {output.type === 'address' ? (
                <div>
                    <span className="font-medium">Type:</span> Address <br />
                    <span className="font-medium">Address:</span> {output.address || 'N/A'} <br />
                    <span className="font-medium">Value (BTC):</span> {(output.value / 100000000).toFixed(8) || 'N/A'}
                </div>
            ) : output.type === 'nulldata' ? (
                <div>
                    <div className="mb-1">
                        <span className="font-medium">
                            <Tooltip>
                                <TooltipTrigger asChild><span className="underline decoration-dotted cursor-help">Type:</span></TooltipTrigger>
                                <TooltipContent className="bg-background text-foreground"><p>Unspendable output used to store arbitrary data on the blockchain (e.g., for merged mining).</p></TooltipContent>
                            </Tooltip> OP_RETURN 
                        </span> 
                        {output.decodedData && output.decodedData.protocol !== 'Unknown' && ( 
                            <span className="italic text-blue-500 dark:text-blue-400"> ({output.decodedData.protocol})</span>
                        )}
                    </div>
                    <div className="mb-1">
                        <span className="font-medium">Value (BTC):</span> {(output.value / 100000000).toFixed(8) || 'N/A'}
                    </div>
                    {output.decodedData?.details && Object.keys(output.decodedData.details).length > 0 && (
                        <div className="mb-1 border-t border-gray-300 dark:border-gray-600 pt-1">
                            <span className="font-medium">Decoded:</span>
                            <ul className="list-disc list-inside pl-2">
                                {output.decodedData.protocol === 'CoreDAO' && output.decodedData.details.validatorAddress ? (
                                    <> 
                                        <li><span className="font-semibold">Validator Address:</span> <a href={`https://scan.coredao.org/address/${output.decodedData.details.validatorAddress}`} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline break-all">{output.decodedData.details.validatorAddress}</a></li>
                                        <li><span className="font-semibold">Reward Address:</span> <a href={`https://scan.coredao.org/address/${output.decodedData.details.rewardAddress}`} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline break-all">{output.decodedData.details.rewardAddress || 'N/A'}</a></li>
                                    </>
                                ) : (
                                    Object.entries(output.decodedData.details).map(([key, value]) => (
                                        <li key={key}><span className="font-semibold capitalize">{key.replace(/([A-Z])/g, ' $1')}:</span> <span className="break-all">{String(value)}</span></li>
                                    ))
                                )}
                            </ul>
                        </div>
                    )}
                    {showRawData && (
                        <div className="border-t border-gray-300 dark:border-gray-600 pt-1">
                            <span className="font-medium">Data (hex):</span> <span className="break-all">{output.decodedData?.dataHex || output.hex || 'N/A'}</span>
                        </div>
                    )}
                </div>
            ) : (
                <div>
                    <span className="font-medium">Type:</span> Unknown/Unparseable <br />
                    <span className="font-medium">Script (hex):</span> <span className="break-all">{output.hex || 'N/A'}</span> <br />
                    <span className="font-medium">Value (BTC):</span> {(output.value / 100000000).toFixed(8) || 'N/A'}
                </div>
            )}
        </div>
    );
});
CoinbaseOutputItem.displayName = 'CoinbaseOutputItem'; // Add display name for memo

// New component to render JSON with colored Merkle branches
interface JsonViewerProps {
  data?: StratumV1Data | null;
}

const JsonViewerWithMerkleColors: React.FC<JsonViewerProps> = ({ data }) => {
  if (!data) {
    return null;
  }

  // Create a mutable copy for redaction
  const displayMessage = { ...data };

  // Manually remove/redact properties
  delete (displayMessage as Record<string, unknown>)._id;
  delete (displayMessage as Record<string, unknown>).job_id;
  delete (displayMessage as Record<string, unknown>).extranonce1;
  delete (displayMessage as Record<string, unknown>).timestamp; // Hide timestamp
  delete (displayMessage as Record<string, unknown>).pool_name; // Hide pool_name
  delete (displayMessage as Record<string, unknown>).height;    // Hide height

  // Add redacted values back
  const redactedMessage = {
    ...displayMessage,
    job_id: '[REDACTED]',
    extranonce1: '[REDACTED]',
  };

  const jsonString = JSON.stringify(redactedMessage, null, 2);
  const lines = jsonString.split('\n');

  // Regex to find lines containing merkle branch hashes
  // Looks for lines like: "  "<hash>", " or "  "<hash>" "
  const merkleBranchRegex = /^(\s*)"([a-f0-9]{64})"(,?)(\s*)$/;

  return (
    <>
      {lines.map((line, index) => {
        const match = line.match(merkleBranchRegex);
        if (match && data.merkle_branches?.includes(match[2])) { // Check if the hash is actually in the original branches
          const indent = match[1];
          const hash = match[2];
          const comma = match[3];
          const trailingSpace = match[4];
          const color = getMerkleColor(hash);
          return (
            <span key={index} style={{ display: 'block' }}>
              {indent}&quot;<span style={{ backgroundColor: color, color: 'black', padding: '1px 2px', borderRadius: '2px' }}>{hash}</span>&quot;{comma}{trailingSpace}
            </span>
          );
        } else {
          return (
            <span key={index} style={{ display: 'block' }}>
              {line}
            </span>
          );
        }
      })}
    </>
  );
};

const BlockTemplateCard: React.FC<BlockTemplateCardProps> = ({ latestMessage }) => {
    // Add state for the toggle
    const [showRawOutputData, setShowRawOutputData] = useState(false);

    const rowData: SortedRow | null = useMemo(() => {
        if (!latestMessage) return null;

        try {
            const cbRaw = (
                latestMessage.coinbase1 + 
                latestMessage.extranonce1 + 
                ('00'.repeat(latestMessage.extranonce2_length)) + 
                latestMessage.coinbase2
            );

            const { scriptSigInfo, txDetails } = parseCoinbaseData(cbRaw);
            const coinbaseOutputValue = computeCoinbaseOutputValue(cbRaw);
            const coinbaseOutputs = computeCoinbaseOutputs(cbRaw);
            const asciiTag = getFormattedCoinbaseAsciiTag(
                latestMessage.coinbase1,
                latestMessage.extranonce1,
                latestMessage.extranonce2_length,
                latestMessage.coinbase2
            );

            return {
                pool_name: latestMessage.pool_name,
                timestamp: latestMessage.timestamp,
                job_id: latestMessage.job_id,
                height: latestMessage.height,
                prev_hash: latestMessage.prev_hash,
                version: latestMessage.version,
                coinbase1: latestMessage.coinbase1,
                coinbase2: latestMessage.coinbase2,
                extranonce1: latestMessage.extranonce1,
                extranonce2_length: latestMessage.extranonce2_length,
                clean_jobs: latestMessage.clean_jobs,
                first_transaction: latestMessage.first_transaction,
                fee_rate: latestMessage.fee_rate,
                merkle_branches: latestMessage.merkle_branches,
                merkle_branch_colors: latestMessage.merkle_branch_colors,
                nbits: latestMessage.nbits,
                ntime: latestMessage.ntime,
                coinbaseRaw: cbRaw,
                coinbaseScriptASCII: asciiTag,
                coinbaseOutputValue: coinbaseOutputValue,
                coinbase_outputs: coinbaseOutputs,
                feeRateComputed: "N/A",
                auxPowData: scriptSigInfo?.auxPowData || null,
                coinbaseHeight: scriptSigInfo?.height || null,
                txVersion: txDetails?.txVersion,
                inputSequence: txDetails?.inputSequence,
                txLocktime: txDetails?.txLocktime,
                witnessCommitmentNonce: txDetails?.witnessCommitmentNonce || null
            };
        } catch (error) {
            console.error("Error preparing row data in BlockTemplateCard:", error);
            return null;
        }
    }, [latestMessage]);

    const prevMessageRef = useRef<StratumV1Data | undefined>(undefined);

    useEffect(() => {
        prevMessageRef.current = latestMessage;
    });

    const versionFlash = useFlashOnUpdate(latestMessage?.version);
    const nbitsFlash = useFlashOnUpdate(latestMessage?.nbits);
    const ntimeFlash = useFlashOnUpdate(latestMessage?.ntime);
    const prevHashFlash = useFlashOnUpdate(latestMessage?.prev_hash);
    const parsedHeightFlash = useFlashOnUpdate(rowData?.coinbaseHeight);
    const scriptAsciiFlash = useFlashOnUpdate(rowData?.coinbaseScriptASCII);
    const auxPowFlash = useFlashOnUpdate(JSON.stringify(rowData?.auxPowData));
    const txVersionFlash = useFlashOnUpdate(rowData?.txVersion);
    const inputSequenceFlash = useFlashOnUpdate(rowData?.inputSequence);
    const txLocktimeFlash = useFlashOnUpdate(rowData?.txLocktime);
    const witnessNonceFlash = useFlashOnUpdate(rowData?.witnessCommitmentNonce);
    const outputValueFlash = useFlashOnUpdate(rowData?.coinbaseOutputValue);
    const extranonce2LenFlash = useFlashOnUpdate(latestMessage?.extranonce2_length);

  return (
    <TooltipProvider>
      <div className="w-full relative">
        <div className="relative p-4 rounded-lg border bg-card shadow-md flex flex-col items-stretch w-full font-mono text-xs">
            {latestMessage && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 mb-6">
                    <div className="border-r border-gray-300 dark:border-gray-600 pr-6">
                        <div className="text-sm font-semibold mb-2 text-center text-foreground">Raw Stratum Data (mining.notify)</div>
                        <div className="bg-muted p-2 rounded mt-1 overflow-x-auto">
                            <pre style={{ fontSize: '0.7rem' }}><code>
                              <JsonViewerWithMerkleColors data={latestMessage} />
                            </code></pre>
                        </div>
                    </div>
                    <div>
                        <div className="text-sm text-center font-bold text-foreground mb-3 pb-2">Merkle Tree Path Visualization</div>
                        <div className="rounded p-2 bg-muted/20 flex items-center justify-center">
                            <MerkleTreeVisualization
                                coinbaseTxHash={rowData?.coinbaseRaw ? "Coinbase Tx" : undefined}
                                merkleBranches={latestMessage?.merkle_branches}
                            />
                        </div>
                    </div>
                </div>
            )}
            <div className="mb-6">
                <div className="text-sm font-bold text-center text-foreground pb-1 mb-2">Block Header Structure (80 bytes total)</div>
                <div className="flex border rounded divide-x text-center text-[10px] overflow-hidden bg-muted/20">
                    <div className="py-2 px-1 flex flex-col justify-between items-center flex-shrink-0" style={{ flexBasis: '6%' }}>
                        <div className="font-semibold">Version</div>
                        <div className="text-muted-foreground text-[9px]">(4 bytes)</div>
                        <div className={`mt-1 break-all ${versionFlash}`}>
                            {latestMessage ? `0x${latestMessage.version}` : '...'}
                        </div>
                    </div>
                    <div className="py-2 px-1 flex flex-col justify-between items-center flex-grow" style={{ flexBasis: '40%' }}>
                        <div className="font-semibold">Prev Block Hash</div>
                        <div className="text-muted-foreground text-[9px]">(32 bytes)</div>
                        <div className={`mt-1 break-all ${prevHashFlash}`}>
                            {latestMessage?.prev_hash || '...'}
                        </div>
                    </div>
                    <div className="py-2 px-1 flex flex-col justify-between items-center flex-grow" style={{ flexBasis: '40%' }}>
                        <Tooltip>
                            <TooltipTrigger asChild><div className="font-semibold underline decoration-dotted cursor-help">Merkle Root</div></TooltipTrigger>
                            <TooltipContent className="bg-background text-foreground"><p>Root hash of the block&apos;s transaction Merkle tree. Depends on miner&apos;s extranonce2 choice.</p></TooltipContent>
                        </Tooltip>
                        <div className="text-muted-foreground text-[9px]">(32 bytes)</div>
                        <div className="mt-1 break-all italic text-muted-foreground">
                            [computed]
                        </div>
                    </div>
                    <div className="py-2 px-1 flex flex-col justify-between items-center flex-shrink-0" style={{ flexBasis: '6%' }}>
                        <Tooltip>
                            <TooltipTrigger asChild><div className="font-semibold underline decoration-dotted cursor-help">Time</div></TooltipTrigger>
                            <TooltipContent className="bg-background text-foreground"><p>Block timestamp (ntime). Usually set by the pool.</p></TooltipContent>
                        </Tooltip>
                        <div className="text-muted-foreground text-[9px]">(4 bytes)</div>
                        <div className={`mt-1 break-all ${ntimeFlash}`}>
                            {latestMessage?.ntime || '...'}
                        </div>
                    </div>
                    <div className="py-2 px-1 flex flex-col justify-between items-center flex-shrink-0" style={{ flexBasis: '6%' }}>
                        <Tooltip>
                            <TooltipTrigger asChild><div className="font-semibold underline decoration-dotted cursor-help">nBits</div></TooltipTrigger>
                            <TooltipContent className="bg-background text-foreground"><p>Block difficulty target in compact format.</p></TooltipContent>
                        </Tooltip>
                        <div className="text-muted-foreground text-[9px]">(4 bytes)</div>
                        <div className={`mt-1 break-all ${nbitsFlash}`}>
                            {latestMessage ? formatNbits(latestMessage.nbits) : '...'}
                        </div>
                    </div>
                    <div className="py-2 px-1 flex flex-col justify-between items-center flex-shrink-0" style={{ flexBasis: '6%' }}>
                        <Tooltip>
                            <TooltipTrigger asChild><div className="font-semibold underline decoration-dotted cursor-help">Nonce</div></TooltipTrigger>
                            <TooltipContent className="bg-background text-foreground"><p>Field iterated by the miner to find a valid block hash.</p></TooltipContent>
                        </Tooltip>
                        <div className="text-muted-foreground text-[9px]">(4 bytes)</div>
                        <div className="mt-1 break-all italic text-muted-foreground">
                            [computed]
                        </div>
                    </div>
                </div>
            </div>

            {rowData && (
                <div className="mt-6">
                    <div className="text-sm font-bold text-center text-foreground border-b pb-2 mb-3">Coinbase Transaction Details</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
                        <div> 
                            <div className="border rounded p-3 mb-4 bg-muted/20 flex-grow">
                                <div className="text-sm font-semibold text-center text-foreground pb-1 mb-3 border-b">General Transaction Fields</div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-[10px]">
                                    <div>
                                        <div className="font-medium text-muted-foreground mb-0.5">Transaction Version:</div>
                                        <div className={`p-2 border rounded font-mono text-[11px] bg-card/80 ${txVersionFlash}`}>{rowData.txVersion ?? 'N/A'}</div>
                                    </div>
                                    <div>
                                        <div className="font-medium text-muted-foreground mb-0.5">Input Sequence:</div>
                                        <div className={`p-2 border rounded font-mono text-[11px] bg-card/80 ${inputSequenceFlash}`}>{rowData.inputSequence !== undefined ? `0x${rowData.inputSequence.toString(16)}` : 'N/A'}</div>
                                    </div>
                                    <div>
                                        <div className="font-medium text-muted-foreground mb-0.5">Transaction Locktime:</div>
                                        <div className={`p-2 border rounded font-mono text-[11px] bg-card/80 ${txLocktimeFlash}`}>{rowData.txLocktime ?? 'N/A'}</div>
                                    </div>
                                    {rowData.witnessCommitmentNonce && (
                                        <div className="sm:col-span-2">
                                            <div className="font-medium text-muted-foreground mb-0.5">Witness Commitment Nonce:</div>
                                            <div className={`p-2 border rounded font-mono text-[11px] break-all bg-card/80 ${witnessNonceFlash}`}>{rowData.witnessCommitmentNonce}</div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="border rounded p-3 mb-4 bg-muted/20 flex-grow">
                                <div className="text-sm font-semibold text-center text-foreground pb-1 mb-3 border-b">ScriptSig Data</div>
                                <div className="space-y-4 text-[10px]">
                                    {rowData.coinbaseHeight !== null && rowData.coinbaseHeight !== undefined && (
                                        <div>
                                            <div className="font-medium text-muted-foreground mb-0.5">Parsed Height:</div>
                                            <div className={`p-2 border rounded font-mono text-[11px] bg-card/80 ${parsedHeightFlash}`}>{rowData.coinbaseHeight}</div>
                                        </div>
                                    )}
                                    <div>
                                        <div className="font-medium text-muted-foreground mb-0.5">
                                            <Tooltip>
                                                <TooltipTrigger asChild><span className="underline decoration-dotted cursor-help">ASCII tag:</span></TooltipTrigger>
                                                <TooltipContent className="bg-background text-foreground"><p>The ASCII-printable parts of the Coinbase input script, excluding parsed height and AuxPOW data.</p></TooltipContent>
                                            </Tooltip>
                                        </div>
                                        <div className={`p-2 border rounded break-words font-mono text-[11px] bg-card/80 ${scriptAsciiFlash}`}>
                                            {rowData.coinbaseScriptASCII || '(No printable ASCII)'}
                                        </div>
                                    </div>
                                    {latestMessage?.extranonce1 && (
                                        <div>
                                            <div className="font-medium text-muted-foreground mb-0.5">
                                                <Tooltip>
                                                    <TooltipTrigger asChild><span className="underline decoration-dotted cursor-help">Extranonce1 (Pool):</span></TooltipTrigger>
                                                    <TooltipContent className="bg-background text-foreground"><p>Pool-provided nonce part (usually static per job).</p></TooltipContent>
                                                </Tooltip>
                                            </div>
                                            <div className={`p-2 border rounded font-mono text-[11px] bg-card/80 text-muted-foreground`}>[REDACTED]</div>
                                        </div>
                                    )}
                                    {latestMessage?.extranonce2_length !== undefined && (
                                        <div>
                                            <div className="font-medium text-muted-foreground mb-0.5">
                                                <Tooltip>
                                                    <TooltipTrigger asChild><span className="underline decoration-dotted cursor-help">Extranonce2 Length:</span></TooltipTrigger>
                                                    <TooltipContent className="bg-background text-foreground"><p>Required length (bytes) of the nonce part the miner generates.</p></TooltipContent>
                                                </Tooltip>
                                            </div>
                                            <div className={`p-2 border rounded font-mono text-[11px] bg-card/80 ${extranonce2LenFlash}`}>{latestMessage.extranonce2_length} bytes</div>
                                        </div>
                                    )}
                                    {rowData.auxPowData && (
                                        <div className="mt-2 border-t pt-3">
                                            <div className="font-medium text-muted-foreground mb-1">Auxiliary Proof-of-Work (AuxPOW):</div>
                                            <div className={`space-y-2 text-[10px] border rounded p-2 bg-card/50 ${auxPowFlash}`}>
                                                <div>
                                                    <span className="font-semibold">
                                                        <Tooltip>
                                                            <TooltipTrigger asChild><span className="underline decoration-dotted cursor-help">Aux Merkle Root:</span></TooltipTrigger>
                                                            <TooltipContent className="bg-background text-foreground"><p>Merkle Root of the auxiliary chain block, found after AuxPOW magic bytes.</p></TooltipContent>
                                                        </Tooltip>
                                                    </span>
                                                    <span className="break-all ml-1">
                                                        {rowData.auxPowData.auxHashOrRoot}
                                                    </span>
                                                </div>
                                                {rowData.auxPowData.merkleSize !== undefined && rowData.auxPowData.merkleSize !== null && (
                                                    <div><span className="font-semibold">Aux Merkle Size:</span> <span>{rowData.auxPowData.merkleSize}</span></div>
                                                )}
                                                {rowData.auxPowData.nonce !== undefined && rowData.auxPowData.nonce !== null && (
                                                    <div><span className="font-semibold">Aux Nonce:</span> <span>{rowData.auxPowData.nonce}</span></div>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div> 
                        <div> 
                            <div className="border rounded p-3 bg-muted/20 flex-grow">
                                <div className="flex justify-between items-center pb-1 mb-3 border-b">
                                    <div className="text-sm font-semibold text-center text-foreground">Outputs (vout)</div>
                                    <div className="flex items-center space-x-2">
                                        <Label htmlFor="raw-output-toggle" className="text-xs">Show Raw Hex</Label>
                                        <Switch 
                                            id="raw-output-toggle"
                                            checked={showRawOutputData}
                                            onCheckedChange={setShowRawOutputData}
                                            className="data-[state=checked]:bg-orange-500 data-[state=unchecked]:bg-gray-200 dark:data-[state=unchecked]:bg-gray-700"
                                        />
                                    </div>
                                </div>
                                <div className="space-y-2 text-[10px]">
                                    {rowData.coinbase_outputs && rowData.coinbase_outputs.length > 0 ? (
                                        rowData.coinbase_outputs.map((output, index) => (
                                            <CoinbaseOutputItem key={index} output={output} showRawData={showRawOutputData} />
                                        ))
                                    ) : (
                                        <div className="p-1.5 border rounded italic text-[10px]">
                                            No outputs found or unable to parse.
                                        </div>
                                    )}
                                </div>
                                {rowData.coinbaseOutputValue !== undefined && (
                                    <div className="mt-3 border-t pt-3 text-[10px]">
                                        <div className="font-medium text-muted-foreground mb-0.5">Total Output Value (BTC):</div>
                                        <div className={`p-2 border rounded font-mono text-[11px] bg-card/80 ${outputValueFlash}`}>
                                            {(rowData.coinbaseOutputValue / 100000000).toFixed(8)}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div> 
                    </div>
                </div>
            )}
        </div>
      </div>
    </TooltipProvider>
  );
};

export default BlockTemplateCard; 