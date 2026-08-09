export {}

declare global {
  interface Window {
    agentMvp: {
      getState(): Promise<any>
      saveProvider(value: any): Promise<any>
      createFixture(sourceId: 'loopback' | 'mic'): Promise<any>
      messages(sessionId: string): Promise<any>
      chat(sessionId: string, prompt: string): Promise<any>
      preview(sessionId: string): Promise<any>
      confirm(previewId: string, decision: 'accepted' | 'rejected'): Promise<any>
      cancel(runId: string): Promise<any>
      onState(callback: (value: any) => void): () => void
      onEvent(callback: (value: any) => void): () => void
    }
  }
}
