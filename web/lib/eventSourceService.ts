/**
 * EventSource Service
 * 
 * This service handles the connection to the EventSource API and processes events.
 */

import { MiningEvent } from './sankeyDataProcessor';

type EventCallback = (event: MiningEvent) => void;

class EventSourceService {
  private eventSource: EventSource | null = null;
  private eventCallbacks: EventCallback[] = [];
  private simulationInterval: NodeJS.Timeout | null = null;
  private connectionAttempts: number = 0;
  private maxConnectionAttempts: number = 3;
  
  /**
   * Connect to the EventSource API
   */
  public connect(url: string): void {
    // Disconnect if already connected
    if (this.eventSource) {
      this.disconnect();
    }
    
    try {
      console.log(`Connecting to EventSource at ${url}`);
      
      // Reset connection attempts
      this.connectionAttempts = 0;
      
      // Create new EventSource
      this.eventSource = new EventSource(url);
      
      this.eventSource.onopen = () => {
        console.log('Connected to EventSource API');
        // Reset connection attempts on successful connection
        this.connectionAttempts = 0;
      };
      
      this.eventSource.onmessage = (event) => {
        try {
          console.log('Received event data:', event.data);
          const data = JSON.parse(event.data);
          
          // Check if this is a mining event with the expected structure
          if (data && data.poolName && Array.isArray(data.merkleBranches)) {
            this.notifyCallbacks(data);
          } else if (data && data.type === 'connection') {
            console.log('Connection message:', data.message);
          } else {
            console.log('Received non-mining event:', data);
          }
        } catch (error) {
          console.error('Error parsing event data:', error);
        }
      };
      
      this.eventSource.onerror = (error) => {
        // Log error details
        console.error('EventSource error:', error);
        
        // Increment connection attempts
        this.connectionAttempts++;
        
        // If we've exceeded max attempts, disconnect
        if (this.connectionAttempts >= this.maxConnectionAttempts) {
          console.error(`Failed to connect after ${this.maxConnectionAttempts} attempts. Disconnecting.`);
          this.disconnect();
        } else {
          console.log(`Connection error. Attempt ${this.connectionAttempts} of ${this.maxConnectionAttempts}.`);
          // The browser will automatically try to reconnect
        }
      };
    } catch (error) {
      console.error('Error creating EventSource:', error);
    }
  }
  
  /**
   * Disconnect from the EventSource API
   */
  public disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
      console.log('Disconnected from EventSource API');
    }
    
    // Also stop any simulation
    this.stopSimulation();
  }
  
  /**
   * Check if currently connected
   */
  public isConnected(): boolean {
    return this.eventSource !== null;
  }
  
  /**
   * Register a callback for mining events
   */
  public onEvent(callback: EventCallback): void {
    this.eventCallbacks.push(callback);
  }
  
  /**
   * Remove a callback
   */
  public offEvent(callback: EventCallback): void {
    this.eventCallbacks = this.eventCallbacks.filter(cb => cb !== callback);
  }
  
  /**
   * Notify all callbacks of a new event
   */
  private notifyCallbacks(event: MiningEvent): void {
    console.log('Notifying callbacks with event:', event);
    this.eventCallbacks.forEach(callback => {
      try {
        callback(event);
      } catch (error) {
        console.error('Error in event callback:', error);
      }
    });
  }
  
  /**
   * Simulate mining events for testing
   */
  public simulateEvents(): void {
    // Stop any existing simulation
    this.stopSimulation();
    
    console.log('Starting event simulation');
    
    // Sample pool names and merkle branches
    const pools = ['Pool A', 'Pool B', 'Pool C', 'Pool D', 'Pool E'];
    const branches = ['Branch 1', 'Branch 2', 'Branch 3', 'Branch 4', 'Branch 5', 'Branch 6', 'Branch 7', 'Branch 8'];
    
    // Start simulation
    this.simulationInterval = setInterval(() => {
      // Generate a random mining event
      const poolName = pools[Math.floor(Math.random() * pools.length)];
      const numBranches = Math.floor(Math.random() * 4) + 1; // 1-4 branches
      const merkleBranches = [];
      
      // Select random branches without duplicates
      const availableBranches = [...branches];
      for (let i = 0; i < numBranches; i++) {
        if (availableBranches.length === 0) break;
        
        const randomIndex = Math.floor(Math.random() * availableBranches.length);
        merkleBranches.push(availableBranches[randomIndex]);
        availableBranches.splice(randomIndex, 1);
      }
      
      // Create and notify about the event
      const event: MiningEvent = {
        poolName,
        merkleBranches
      };
      
      console.log('Simulated event:', event);
      this.notifyCallbacks(event);
    }, 2000); // Generate an event every 2 seconds
  }
  
  /**
   * Stop simulation
   */
  private stopSimulation(): void {
    if (this.simulationInterval) {
      clearInterval(this.simulationInterval);
      this.simulationInterval = null;
      console.log('Stopped event simulation');
    }
  }
}

// Create a singleton instance
export const eventSourceService = new EventSourceService();
