import { serverGet } from '@/lib/api/server';

export default async function InboxPage({ params }: { params: Promise<{ tenant: string }> }) {
  await params; // Acknowledge params without extracting unused tenant
  
  // Fetch sessions
  const sessionsRes = await serverGet<{ items: Record<string, unknown>[] }>(`/chats`);
  const sessions = sessionsRes?.items || [];

  return (
    <div className="flex h-[calc(100vh-100px)] w-full gap-4 p-4">
      {/* Left Sidebar - Chat List */}
      <div className="w-1/3 h-full flex flex-col border rounded-lg bg-white shadow-sm">
        <div className="p-4 border-b font-semibold">
          Inbox
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {sessions.length === 0 ? (
            <div className="text-sm text-slate-500 text-center py-4">No chats found.</div>
          ) : (
            sessions.map((session, index) => (
              <div key={String(session.id)} className={`p-3 mb-2 border rounded-lg cursor-pointer transition-colors ${index === 0 ? 'bg-slate-50' : 'hover:bg-slate-50'}`}>
                <div className="font-semibold text-sm">{String(session.customerNumber || "")}</div>
                <div className="text-xs text-muted-foreground truncate">{String(session.latestMessage || "No messages yet")}</div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right Area - Chat Window */}
      <div className="w-2/3 h-full flex flex-col border rounded-lg bg-white shadow-sm">
        <div className="p-4 border-b font-semibold">
          Chat: {sessions[0] ? String(sessions[0].customerNumber) : "Select a chat"}
        </div>
        <div className="flex-1 flex flex-col p-4 overflow-y-auto gap-3">
            {sessions.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-slate-500">
                Inbox is empty.
              </div>
            ) : (
              <>
                {/* Outbound AI Message */}
                <div className="flex w-full justify-end">
                  <div className="bg-blue-600 text-white p-3 rounded-lg max-w-[80%] text-sm">
                    Sure, here is the document you requested.
                    <div className="mt-2 p-2 bg-blue-700/50 rounded flex items-center gap-2">
                      📄 info-brochure.pdf
                    </div>
                  </div>
                </div>
              </>
            )}
        </div>
        {/* Input Area */}
        <div className="p-3 border-t flex gap-2">
          <input 
            type="text" 
            placeholder="Type a message to take over from AI..." 
            className="flex-1 px-3 py-2 border rounded-md text-sm outline-none focus:border-blue-500"
            disabled={sessions.length === 0}
          />
          <button 
            disabled={sessions.length === 0}
            className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
