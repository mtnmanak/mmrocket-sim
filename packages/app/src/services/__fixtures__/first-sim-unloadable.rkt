<RockSimDocument>
  <FileVersion>4</FileVersion>
  <!--
    A RockSim file whose FIRST stored simulation names a motor this app's
    catalogue does not have, whose second names another it does not have, and
    whose third flies an Estes C6 on RockSim's "every delay" run. Hand-written
    for importApply.repick.test.ts (seam review of audit 2026-09-22): the reader
    opens simulation 1, and the open must show simulation 3 instead.

    The first was J240-RL, from the owner's Level2-PELTZER.rkt, until audit
    2026-09-23 taught the matcher Cesaroni's propellant codes: that is
    Cesaroni's 54 mm J240 Red Lightning, and it loads now. ZQ240-RL is made up.
  -->
  <DesignInformation>
    <RocketDesign>
      <Name>First Sim Unloadable</Name>
      <StageCount>1</StageCount>
      <Stage3Parts>
        <NoseCone>
          <Name>Nose cone</Name>
          <SerialNo>1</SerialNo>
          <Len>70</Len>
          <BaseDia>24.8</BaseDia>
          <WallThickness>1</WallThickness>
          <ShapeCode>1</ShapeCode>
          <Density>1000</Density>
        </NoseCone>
        <BodyTube>
          <Name>Body tube</Name>
          <SerialNo>2</SerialNo>
          <OD>24.8</OD>
          <ID>24.1</ID>
          <Len>300</Len>
          <Density>680</Density>
          <AttachedParts>
            <BodyTube>
              <Name>Motor mount</Name>
              <SerialNo>7</SerialNo>
              <OD>19</OD>
              <ID>18</ID>
              <Len>70</Len>
              <Density>680</Density>
              <IsMotorMount>1</IsMotorMount>
              <IsInsideTube>1</IsInsideTube>
              <LocationMode>2</LocationMode>
              <Xb>0</Xb>
            </BodyTube>
          </AttachedParts>
        </BodyTube>
      </Stage3Parts>
      <Stage2Parts></Stage2Parts>
      <Stage1Parts></Stage1Parts>
    </RocketDesign>
  </DesignInformation>
  <SimulationResultsList>
    <SimulationResults>
      <SimulationName>[ZQ240-RL-None] </SimulationName>
      <Stage3Engines>
        <EngineSet>
          <EngineCount>1</EngineCount>
          <EngineCode>ZQ240-RL</EngineCode>
          <IgnitionDelay>0.</IgnitionDelay>
          <EngineMfg>AeroTech</EngineMfg>
          <MountSerialNo>7</MountSerialNo>
          <EjectionDelay>-2.</EjectionDelay>
        </EngineSet>
      </Stage3Engines>
    </SimulationResults>
    <SimulationResults>
      <SimulationName>[ZQ9999X-5] </SimulationName>
      <Stage3Engines>
        <EngineSet>
          <EngineCount>1</EngineCount>
          <EngineCode>ZQ9999X</EngineCode>
          <IgnitionDelay>0.</IgnitionDelay>
          <EngineMfg>Estes</EngineMfg>
          <MountSerialNo>7</MountSerialNo>
          <EjectionDelay>5.</EjectionDelay>
        </EngineSet>
      </Stage3Engines>
    </SimulationResults>
    <SimulationResults>
      <SimulationName>[C6-*] </SimulationName>
      <Stage3Engines>
        <EngineSet>
          <EngineCount>1</EngineCount>
          <EngineCode>C6</EngineCode>
          <IgnitionDelay>0.</IgnitionDelay>
          <EngineMfg>Estes</EngineMfg>
          <MountSerialNo>7</MountSerialNo>
          <EjectionDelay>-1.</EjectionDelay>
        </EngineSet>
      </Stage3Engines>
    </SimulationResults>
  </SimulationResultsList>
</RockSimDocument>
