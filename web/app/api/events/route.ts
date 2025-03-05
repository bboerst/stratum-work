import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * This is a simple implementation of a Server-Sent Events (SSE) endpoint
 * that simulates mining events for the Sankey diagram.
 */
export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();
  const customReadable = new ReadableStream({
    async start(controller) {
      // Initial connection message
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'connection', message: 'Connected to event stream' })}\n\n`));
      
      // Sample pool names and merkle branches
      const pools = ['TrustPool', 'SlushPool', 'F2Pool', 'AntPool', 'ViaBTC'];
      const branches = [
        '720dff23f5d3511574d646d0e8bdbb8a7c040bf3ddd2015217373efe408bb750',
        '1cf5d3bea4dd10db1d91159dfdeb7414686d887f6ce0e97a15aebb3ab5fe0c56',
        '45eb2d0eb6e1caaa80f54ab77cd1e91b484b6218ec58ed4406f8f305cb97faf6',
        'be117003d4b7dca8c900bb88c686e4e447027829f894c1f4a6789b3a14334074',
        '30745d83854c779189261b15269d175d2f080bf448cfe8b730c006a7aff509c9',
        '4b26db3a172d0bda8522c196127832ea58c8b618dec7582abff0fd247c21ef43',
        'd1ee86066fa6edeefe51309fa0107ce3d27c404dd92af64a0ef6d66b8cd7055e',
        'd7dbf68fcd461acf7e7120619a281704ddf857e92f63d0f94eb2f9da0384d397'
      ];
      
      // Send an event every 2 seconds
      let count = 0;
      const interval = setInterval(() => {
        try {
          // Generate a random mining event
          const poolName = pools[Math.floor(Math.random() * pools.length)];
          const numBranches = Math.floor(Math.random() * 3) + 1; // 1-3 branches
          const merkleBranches = [];
          
          // Select random branches without duplicates
          const availableBranches = [...branches];
          for (let i = 0; i < numBranches; i++) {
            if (availableBranches.length === 0) break;
            
            const randomIndex = Math.floor(Math.random() * availableBranches.length);
            merkleBranches.push(availableBranches[randomIndex]);
            availableBranches.splice(randomIndex, 1);
          }
          
          // Create the event data in the same format as the global data stream
          const timestamp = Date.now().toString(16);
          const id = crypto.randomUUID();
          
          const eventData = {
            type: "stratum_v1",
            id: id,
            timestamp: timestamp,
            data: {
              _id: id,
              timestamp: timestamp,
              pool_name: poolName,
              height: 886384 + count,
              job_id: (1000 + count).toString(16),
              prev_hash: "455614cf1847132e914a71a9a22991b65ff17a1600010f950000000000000000",
              coinbase1: "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff5f0370860d182f5669614254432f4d696e6564206279206d696e6572312f2cfabe6d6d7c4c02056de5520baa2dbc582995b327f8c68bc38d5ada7c95d62fac6d0063cc100000000000000010ddbfc20242ac1d89",
              coinbase2: "ffffffff042202c812000000001976a914fb37342f6275b13936799def06f2eb4c0f20151588ac00000000000000002b6a2952534b424c4f434b3aca4485fabdbcdd53ece5ab5e9435abd4fc8a07b4f77ba91bcdabab16006f86590000000000000000146a124558534154011508000113021b1a1f1200130000000000000000266a24aa21a9edc5b57cefe46b26fe2e0f9f50dbaf84f1b7aa6b715c489bdb939f2d86c98bba8e00000000",
              merkle_branches: merkleBranches,
              version: "20000000",
              nbits: "17028bb1",
              ntime: "67c7eb3e",
              clean_jobs: false,
              extranonce1: "731f3567",
              extranonce2_length: 8
            }
          };
          
          // Send the event
          const eventString = `data: ${JSON.stringify(eventData)}\n\n`;
          controller.enqueue(encoder.encode(eventString));
          console.log("Sent event:", eventString);
          
          count++;
          
          // End the stream after 50 events (or about 100 seconds)
          if (count >= 50) {
            clearInterval(interval);
            controller.close();
          }
        } catch (error) {
          console.error("Error sending event:", error);
          // Try to send an error message to the client
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: 'Error generating event' })}\n\n`));
          } catch (e) {
            // If we can't even send the error, just log it
            console.error("Failed to send error message:", e);
          }
        }
      }, 2000);
      
      // Handle client disconnect
      req.signal.addEventListener('abort', () => {
        clearInterval(interval);
        controller.close();
        console.log("Client disconnected, stream closed");
      });
    }
  });
  
  // Return the stream with appropriate headers for SSE
  return new Response(customReadable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no' // Prevents Nginx from buffering the response
    }
  });
}
