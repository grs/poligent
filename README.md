# poligent
proof of concept of a policy agent for Apache Qpid's dispatch router

To run:

  node poligent.js
  
Then have router config include a connector to this agent. The desired.json file holds the desired vhosts. When this is edited,
updates will be pushed to any connected router. When a new router connects it will be synced to the desired set of vhosts.
