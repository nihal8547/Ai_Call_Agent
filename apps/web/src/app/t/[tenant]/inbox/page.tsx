import { notFound } from 'next/navigation';

export default async function InboxPage({ params }: { params: { tenant: string } }) {
  // In a real implementation, we fetch the sessions here:
  // const sessions = await api.chats.list(params.tenant);

  return (
    <div className="flex h-[calc(100vh-100px)] w-full gap-4 p-4">
      {/* Left Sidebar - Chat List */}
      <div className="w-1/3 h-full flex flex-col border rounded-lg bg-white shadow-sm">
        <div className="p-4 border-b font-semibold">
          Inbox
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {/* Mock Chat Item */}
          <div className="p-3 mb-2 border rounded-lg cursor-pointer hover:bg-slate-50 transition-colors">
            <div className="font-semibold text-sm">+1 234 567 8900</div>
            <div className="text-xs text-muted-foreground truncate">Hello, I want to know about your services.</div>
          </div>
          <div className="p-3 mb-2 border rounded-lg cursor-pointer bg-slate-50">
            <div className="font-semibold text-sm">+91 987 654 3210</div>
            <div className="text-xs text-muted-foreground truncate">Can you send the document?</div>
          </div>
        </div>
      </div>

      {/* Right Area - Chat Window */}
      <div className="w-2/3 h-full flex flex-col border rounded-lg bg-white shadow-sm">
        <div className="p-4 border-b font-semibold">
          Chat: +91 987 654 3210
        </div>
        <div className="flex-1 flex flex-col p-4 overflow-y-auto gap-3">
            
            {/* Inbound Message */}
            <div className="flex w-full justify-start">
              <div className="bg-slate-100 p-3 rounded-lg max-w-[80%] text-sm">
                Can you send the document?
              </div>
            </div>

            {/* Outbound AI Message */}
            <div className="flex w-full justify-end">
              <div className="bg-blue-600 text-white p-3 rounded-lg max-w-[80%] text-sm">
                Sure, here is the document you requested.
                <div className="mt-2 p-2 bg-blue-700/50 rounded flex items-center gap-2">
                   📄 info-brochure.pdf
                </div>
              </div>
            </div>

        </div>
        {/* Input Area */}
        <div className="p-3 border-t flex gap-2">
          <input 
            type="text" 
            placeholder="Type a message to take over from AI..." 
            className="flex-1 px-3 py-2 border rounded-md text-sm outline-none focus:border-blue-500"
          />
          <button className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700">
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
