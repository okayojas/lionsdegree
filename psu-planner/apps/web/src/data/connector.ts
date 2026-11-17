/** The address a student pastes into their AI assistant to connect it to
 * LionsDegree: the hosted MCP connector (packages/mcp, worker.ts).
 *
 * ONE COPY IN THE APP. The Connect page publishes it too, as static HTML
 * that has to work without a script, and `connect-address.test.ts` holds
 * this constant, that page and the Worker's own route to the same value:
 * the page once advertised an address that did not exist for months
 * because nothing compared them. */
export const CONNECTOR_URL = "https://mcp.lionsdegree.com/mcp";
