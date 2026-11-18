/** Recorded streaming bodies. Structure mirrors the providers' documented wire formats. */

export const DEEPSEEK_TEXT_SSE = `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2}}

data: [DONE]

`;

export const DEEPSEEK_TOOL_SSE = `data: {"id":"chatcmpl-2","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"I should read the file."},"finish_reason":null}]}

data: {"id":"chatcmpl-2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"src/add.ts\\"}"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-2","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":20,"completion_tokens":9}}

data: [DONE]

`;

export const DEEPSEEK_TRUNCATED_SSE = `data: {"id":"chatcmpl-3","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}

`;

export const DEEPSEEK_MALFORMED_SSE = `data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}

data: {this is not json}

`;

export const OPENAI_TEXT_SSE = `data: {"id":"resp-1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}

data: {"id":"resp-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":5}}}

data: [DONE]

`;

export const ANTHROPIC_TEXT_SSE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":11,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}

`;

export const ANTHROPIC_TOOL_SSE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_2","usage":{"input_tokens":18,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Reading it."}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"src/add.ts\\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}

event: message_stop
data: {"type":"message_stop"}

`;

export const ANTHROPIC_TRUNCATED_SSE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_3","usage":{"input_tokens":4,"output_tokens":1}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"cut off"}}

`;
